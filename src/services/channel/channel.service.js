const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const kie = require('../tiktok/kie.api');
const gemini = require('../tiktok/gemini');
const ffmpeg = require('../tiktok/ffmpeg');
const igpublish = require('../tiktok/igpublish');
const renderService = require('../tiktok/render.service');
const videoService = require('../tiktok/video.service');
const telegram = require('../telegram');
const instagram = require('../instagram.graph');
const IgAccount = require('../../models/IgAccount');
const ChannelVideo = require('../../models/ChannelVideo');

// Niş kanalları: her hesabın paylaşım saatlerinden LEAD_MIN önce Gemini fikri → Grok klibi → hook yazısı →
// Telegram'a "Paylaş / Atla" butonlarıyla gelir; onaylanınca o hesaba Reels olarak yüklenir.
const MODEL = 'grok-imagine/text-to-video';
const RESOLUTION = '720p';
const LEAD_MIN = 30; // video, paylaşım saatinde onaya hazır olsun
const LATE_MIN = 90; // sunucu kapalıyken kaçan saat bu kadar geçmişse atlanır (eski saatleri toplu üretmesin)
const HOOK_SECONDS = 2.5;
const SCHEDULE_MS = 60_000;
const POLL_MS = 20_000;
const PENDING_TIMEOUT_MS = 30 * 60_000;
const KEEP_FILES_MS = 14 * 24 * 3_600_000;
const TOKEN_REFRESH_MS = 7 * 24 * 3_600_000;
const TR_OFFSET_MS = 3 * 3_600_000; // Türkiye UTC+3, yaz saati yok

const DIR = path.join(__dirname, '..', '..', '..', 'storage', 'channels');
fs.mkdirSync(DIR, { recursive: true });

let scheduleTimer = null;
let pollTimer = null;
let polling = false;

const filePath = (name) => path.join(DIR, name);
const short = (err) => String(err?.message || err).slice(0, 500);

// "12:00, 20:30" → [{ h: 12, m: 0 }, ...]; geçersizler atılır
function parseTimes(text) {
  return String(text || '').split(',').map((t) => t.trim()).map((t) => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return { h: Number(m[1]), m: Number(m[2]) };
  }).filter(Boolean);
}

function normalizeTimes(text) {
  return parseTimes(text).map((t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`).join(',');
}

// Bugünün (TR) paylaşım saatleri; slot anahtarı "2026-10-08 12:00"
function todaySlots(account, now = Date.now()) {
  const tr = new Date(now + TR_OFFSET_MS);
  const day = tr.toISOString().slice(0, 10);
  return parseTimes(account.post_times).map(({ h, m }) => {
    const at = Date.UTC(tr.getUTCFullYear(), tr.getUTCMonth(), tr.getUTCDate(), h, m) - TR_OFFSET_MS;
    return { key: `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, at };
  });
}

async function failVideo(id, message) {
  await ChannelVideo.update(id, { status: 'fail', error: String(message).slice(0, 500), completedAt: new Date() });
  await telegram.sendMessage(`❌ Kanal videosu üretilemedi (#${id}): ${telegram.escapeHtml(String(message).slice(0, 300))}`).catch(() => {});
}

async function assertBudget() {
  const usage = await videoService.monthlyUsage();
  if (usage.used >= usage.limit) {
    const err = new Error(`Aylık kredi limiti doldu (${usage.used}/${usage.limit}). Ayarlar'dan limiti artırabilirsin.`);
    err.status = 403;
    throw err;
  }
}

// Fikir + Grok görevi. slot: zamanlanmış saat ya da elle üretimde "manual-<zaman>"
async function generate(account, slot) {
  if (!account.niche) throw Object.assign(new Error('Önce hesaba bir niş seç.'), { status: 400 });
  await assertBudget();
  const id = await ChannelVideo.createForSlot({ account_id: account.id, slot });
  if (!id) return null; // bu saat için zaten üretildi
  try {
    const idea = await gemini.generateChannelIdea({
      niche: account.niche,
      brief: account.niche_brief,
      seconds: account.video_seconds,
      recentTitles: await ChannelVideo.recentTitles(account.id),
    });
    await ChannelVideo.update(id, { idea });
    const taskId = await kie.createTask(MODEL, {
      prompt: idea.prompt,
      aspect_ratio: '9:16',
      duration: account.video_seconds,
      resolution: RESOLUTION,
      mode: 'normal',
    });
    await ChannelVideo.update(id, { kie_task_id: taskId });
    ensurePoller();
  } catch (err) {
    await failVideo(id, short(err));
    throw err;
  }
  return ChannelVideo.findById(id);
}

async function download(url, target) {
  const response = await axios.get(url, { responseType: 'stream', timeout: 120_000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    response.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    response.data.on('error', reject);
  });
}

function captionText(idea) {
  return `${idea.caption}\n\n${idea.hashtags.join(' ')}`;
}

// Klibi 720x1280'e çevirip hook yazısını ekler, sonra Telegram'a onaya gönderir
async function render(id) {
  const video = await ChannelVideo.findById(id);
  if (!video || video.status !== 'rendering') return;
  const account = await IgAccount.findById(video.account_id);
  const raw = filePath(`${id}-raw.mp4`);
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `channel-video-${id}-`));
  try {
    const info = await ffmpeg.probe(raw);
    const seconds = Math.min(info.duration, 30);
    const part = path.join(work, 'part.mp4');
    await renderService.normalizeSegment({ file: raw, hasAudio: info.hasAudio, speed: 1, outSeconds: seconds }, part);

    const assFile = path.join(work, 'subs.ass');
    await fs.promises.writeFile(assFile, renderService.buildAss([
      { start: 0, end: Math.min(HOOK_SECONDS, seconds), style: 'Hook', text: video.idea.hookText },
    ]));
    const fileName = `${id}.mp4`;
    await ffmpeg.run([
      '-i', part,
      '-vf', `ass=${assFile}:fontsdir=${renderService.FONTS_DIR}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart',
      filePath(fileName),
    ]);
    await fs.promises.unlink(raw).catch(() => {});
    await ChannelVideo.update(id, { status: 'ready', file_path: fileName, completedAt: new Date() });

    const header = `📱 @${account?.username || '?'} · ${video.idea.title} (#${id})`;
    await telegram.sendVideo(filePath(fileName), `${header}\n\n🪝 ${video.idea.hookText}\n\n${captionText(video.idea)}`, {
      buttons: [[{ text: '✅ Paylaş', data: `cv:pub:${id}` }, { text: '⏭ Atla', data: `cv:skip:${id}` }]],
    }).catch((err) => console.error('Telegram video hatası:', err.response?.data?.description || err.message));
  } catch (err) {
    console.error(`Kanal videosu #${id} render hatası:`, err.message);
    await failVideo(id, `Birleştirme hatası: ${short(err)}`);
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

async function checkGenerating(video) {
  if (!video.kie_task_id) return;
  const task = await kie.getTask(video.kie_task_id);
  if (task.state === 'success' && task.urls[0]) {
    await download(task.urls[0], filePath(`${video.id}-raw.mp4`));
    if (await ChannelVideo.transition(video.id, 'generating', { status: 'rendering', credits: task.credits })) {
      renderService.exclusive(() => render(video.id)).catch(() => {});
    }
  } else if (task.state === 'fail') {
    await ChannelVideo.update(video.id, { credits: task.credits });
    await failVideo(video.id, task.failMsg || 'kie.ai üretimi başarısız');
  } else if (Date.now() - new Date(video.createdAt).getTime() > PENDING_TIMEOUT_MS) {
    await failVideo(video.id, 'Zaman aşımı (30 dk): kie.ai klibi bitiremedi');
  }
}

async function pollOnce() {
  if (polling) return 1;
  polling = true;
  try {
    const generating = await ChannelVideo.findByStatus('generating');
    for (const video of generating) {
      await checkGenerating(video).catch((err) => console.error(`Kanal videosu #${video.id} kontrol hatası:`, err.message));
    }
    return generating.length;
  } finally {
    polling = false;
  }
}

function ensurePoller() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if ((await pollOnce().catch(() => 1)) === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, POLL_MS);
}

// Onaylanan videoyu hesaba yükler. Panelden ve Telegram butonundan çağrılır.
async function publish(id) {
  const video = await ChannelVideo.findById(id);
  if (!video) throw Object.assign(new Error('Video bulunamadı.'), { status: 404 });
  if (!(await ChannelVideo.transition(id, 'ready', { status: 'publishing', error: null }))) {
    throw Object.assign(new Error(`Video paylaşılamaz durumda (${video.status}).`), { status: 409 });
  }
  const account = await IgAccount.findById(video.account_id);
  // Instagram işlemesi dakikalar sürebilir; çağıran beklemesin
  (async () => {
    try {
      if (!account) throw new Error('Hesap silinmiş.');
      const mediaId = await igpublish.publishFile({
        file: filePath(video.file_path), caption: captionText(video.idea), account, name: `channel-video-${id}`,
      });
      await ChannelVideo.update(id, { status: 'published', ig_media_id: mediaId });
      await telegram.sendMessage(`📸 @${telegram.escapeHtml(account.username)} hesabında paylaşıldı: ${telegram.escapeHtml(video.idea.title)} (#${id})`).catch(() => {});
    } catch (err) {
      // Tekrar denenebilsin diye "hazır"a döner
      await ChannelVideo.update(id, { status: 'ready', error: short(err) });
      await telegram.sendMessage(`⚠️ Instagram paylaşımı başarısız (#${id}): ${telegram.escapeHtml(short(err))}`, {
        buttons: [[{ text: '🔁 Tekrar dene', data: `cv:pub:${id}` }, { text: '⏭ Atla', data: `cv:skip:${id}` }]],
      }).catch(() => {});
    }
  })();
}

async function skip(id) {
  const video = await ChannelVideo.findById(id);
  if (!video) throw Object.assign(new Error('Video bulunamadı.'), { status: 404 });
  if (!(await ChannelVideo.transition(id, 'ready', { status: 'skipped', file_path: null }))) {
    throw Object.assign(new Error(`Video atlanamaz durumda (${video.status}).`), { status: 409 });
  }
  if (video.file_path) await fs.promises.unlink(filePath(video.file_path)).catch(() => {});
}

// Telegram butonları: cv:pub:<id>, cv:skip:<id>
telegram.onCallback('cv', async ([action, idText], query) => {
  const id = Number(idText);
  if (action === 'pub') {
    await publish(id);
    await telegram.clearButtons(query.message.message_id);
    return 'Instagram\'a yükleniyor...';
  }
  if (action === 'skip') {
    await skip(id);
    await telegram.clearButtons(query.message.message_id);
    return 'Atlandı';
  }
  return 'Bilinmeyen işlem';
});

// Her dakika: aktif hesapların yaklaşan saatleri için üretim başlat
async function scheduleTick() {
  const now = Date.now();
  for (const account of await IgAccount.list()) {
    if (!account.active || !account.niche) continue;
    for (const slot of todaySlots(account, now)) {
      if (now < slot.at - LEAD_MIN * 60_000 || now > slot.at + LATE_MIN * 60_000) continue;
      await generate(account, slot.key).catch((err) => {
        if (err.status !== 403) console.error(`@${account.username} ${slot.key} üretim hatası:`, err.message);
      });
    }
  }
}

// Token'lar 60 gün geçerli; haftada bir yenilenir. Yenilenemezse Telegram'a uyarı.
async function refreshTokens() {
  for (const account of await IgAccount.list()) {
    if (Date.now() - new Date(account.token_refreshed_at).getTime() < TOKEN_REFRESH_MS) continue;
    try {
      const token = await instagram.refreshToken(account.access_token);
      await IgAccount.update(account.id, { access_token: token, token_refreshed_at: new Date() });
    } catch (err) {
      await telegram.sendMessage(`⚠️ @${telegram.escapeHtml(account.username)} token'ı yenilenemedi: ${telegram.escapeHtml(short(err))}. Panelden yeni token gir.`).catch(() => {});
    }
  }
}

async function cleanup() {
  for (const video of await ChannelVideo.findExpiredFiles(new Date(Date.now() - KEEP_FILES_MS))) {
    await fs.promises.unlink(filePath(video.file_path)).catch(() => {});
    await ChannelVideo.update(video.id, { file_path: null });
  }
}

// --- Hesap yönetimi ---

async function addAccount({ accessToken, postTimes }) {
  const profile = await instagram.getProfile(accessToken);
  const existing = await IgAccount.findByIgUserId(profile.igUserId);
  if (existing) {
    // Aynı hesabı tekrar eklemek token yenileme gibi davranır
    await IgAccount.update(existing.id, { access_token: accessToken, token_refreshed_at: new Date(), username: profile.username });
    return IgAccount.findById(existing.id);
  }
  const id = await IgAccount.create({
    username: profile.username,
    ig_user_id: profile.igUserId,
    access_token: accessToken,
    post_times: normalizeTimes(postTimes) || '12:00,20:00',
  });
  return IgAccount.findById(id);
}

async function updateAccount(id, fields) {
  const account = await IgAccount.findById(id);
  if (!account) throw Object.assign(new Error('Hesap bulunamadı.'), { status: 404 });
  const out = {};
  if (fields.niche !== undefined) out.niche = String(fields.niche).trim().slice(0, 200) || null;
  if (fields.nicheBrief !== undefined) out.niche_brief = fields.nicheBrief || null;
  if (fields.postTimes !== undefined) {
    const times = normalizeTimes(fields.postTimes);
    if (!times) throw Object.assign(new Error('Saatleri "12:00, 20:00" biçiminde yaz.'), { status: 400 });
    out.post_times = times;
  }
  if (fields.videoSeconds !== undefined) {
    const seconds = Number(fields.videoSeconds);
    if (![6, 8, 10, 15].includes(seconds)) throw Object.assign(new Error('Süre 6, 8, 10 veya 15 sn olmalı.'), { status: 400 });
    out.video_seconds = seconds;
  }
  if (fields.active !== undefined) out.active = !!fields.active;
  const willBeActive = 'active' in out ? out.active : account.active;
  const niche = 'niche' in out ? out.niche : account.niche;
  if (willBeActive && !niche) {
    throw Object.assign(new Error('Otomatik üretimi açmadan önce niş seç.'), { status: 400 });
  }
  if (Object.keys(out).length) await IgAccount.update(id, out);
  return IgAccount.findById(id);
}

async function removeAccount(id) {
  for (const video of await ChannelVideo.list({ accountId: id, limit: 1000 })) {
    if (video.file_path) await fs.promises.unlink(filePath(video.file_path)).catch(() => {});
  }
  await ChannelVideo.removeByAccount(id);
  return IgAccount.remove(id);
}

async function removeVideo(id) {
  const video = await ChannelVideo.findById(id);
  if (!video) return false;
  if (['generating', 'rendering', 'publishing'].includes(video.status)) {
    throw Object.assign(new Error('Video işlenirken silinemez.'), { status: 409 });
  }
  if (video.file_path) await fs.promises.unlink(filePath(video.file_path)).catch(() => {});
  return ChannelVideo.remove(id);
}

// Ayarlar'daki eski tek hesap varsa bir kez hesap listesine taşınır
async function importLegacyAccount() {
  const Setting = require('../../models/Setting');
  const token = await Setting.get('ig_access_token');
  if (!token || (await IgAccount.list()).length) return;
  try {
    await addAccount({ accessToken: token });
    console.log('Ayarlar\'daki Instagram hesabı hesap listesine eklendi');
  } catch (err) {
    console.error('Eski Instagram hesabı taşınamadı:', err.message);
  }
}

async function resume() {
  try {
    await importLegacyAccount();
    for (const video of await ChannelVideo.findByStatus('rendering')) {
      renderService.exclusive(() => render(video.id)).catch(() => {});
    }
    // Yükleme yarıda kaldıysa tekrar denenebilsin
    for (const video of await ChannelVideo.findByStatus('publishing')) {
      await ChannelVideo.update(video.id, { status: 'ready', error: 'Sunucu yeniden başladı, paylaşım yarım kaldı; tekrar dene.' });
    }
    if ((await ChannelVideo.findByStatus('generating')).length) ensurePoller();
    await cleanup();
  } catch (err) {
    console.error('Kanal videoları devam ettirilemedi:', err.message);
  }
  if (!scheduleTimer) {
    scheduleTimer = setInterval(() => {
      scheduleTick().catch((err) => console.error('Kanal zamanlayıcı hatası:', err.message));
    }, SCHEDULE_MS);
    // Token yenileme ve dosya temizliği günde bir
    setInterval(() => {
      refreshTokens().catch(() => {});
      cleanup().catch(() => {});
    }, 24 * 3_600_000);
    refreshTokens().catch(() => {});
  }
}

module.exports = {
  generate, publish, skip, addAccount, updateAccount, removeAccount, removeVideo, resume, filePath, todaySlots,
};
