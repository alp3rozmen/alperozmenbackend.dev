const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kie = require('./kie.api');
const telegram = require('../telegram');
const Setting = require('../../models/Setting');
const TiktokVideo = require('../../models/TiktokVideo');
const { ideaItem, buildCaption } = require('./caption');

const STORAGE_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'tiktok');
const POLL_MS = 20_000;
const PENDING_TIMEOUT_MS = 30 * 60_000;
const KEEP_FILES_MS = 14 * 24 * 3_600_000;
const CREDIT_USD = 0.005;

let pollTimer = null;
const refreshing = new Set(); // aynı videoyu poller ve panel aynı anda tazelemesin

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

async function monthlyUsage() {
  const used = await TiktokVideo.creditsSince(monthStart());
  const limit = Number(await Setting.get('kie_monthly_credit_limit')) || 0;
  return { used, limit, usedUsd: used * CREDIT_USD, limitUsd: limit * CREDIT_USD };
}

function filePathOf(video) {
  return path.join(STORAGE_DIR, video.file_path);
}

async function download(url, target) {
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  const response = await axios.get(url, { responseType: 'stream', timeout: 120_000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    response.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    response.data.on('error', reject);
  });
}

async function notifySuccess(video, sourceUrl) {
  const item = await ideaItem(video.idea_id, video.idea_index);
  const caption = buildCaption(
    `🎬 Hook klibi hazır (#${video.id}, ${video.duration} sn)`,
    item,
    `🔗 Yedek link (24 saat): ${sourceUrl}`
  );
  await telegram.sendVideo(filePathOf(video), caption);
}

async function refresh(id) {
  if (refreshing.has(id)) return TiktokVideo.findById(id);
  refreshing.add(id);
  try {
    const video = await TiktokVideo.findById(id);
    if (!video || video.status !== 'pending' || !video.kie_task_id) return video;

    const task = await kie.getTask(video.kie_task_id);

    if (task.state === 'success' && task.urls[0]) {
      const fileName = `${video.id}.mp4`;
      const tmp = path.join(STORAGE_DIR, `${fileName}.part`);
      await download(task.urls[0], tmp);
      const won = await TiktokVideo.finish(video.id, {
        status: 'success',
        credits: task.credits,
        source_url: task.urls[0],
        file_path: fileName,
        completedAt: new Date(),
      });
      if (!won) {
        await fs.promises.unlink(tmp).catch(() => {});
        return TiktokVideo.findById(id);
      }
      await fs.promises.rename(tmp, path.join(STORAGE_DIR, fileName));
      await notifySuccess({ ...video, file_path: fileName }, task.urls[0])
        .catch((err) => console.error('Telegram video hatası:', err.response?.data?.description || err.message));
    } else if (task.state === 'fail') {
      const won = await TiktokVideo.finish(video.id, {
        status: 'fail',
        credits: task.credits,
        error: String(task.failMsg || 'Üretim başarısız').slice(0, 500),
        completedAt: new Date(),
      });
      if (won) {
        await telegram.sendMessage(`❌ Hook klibi üretilemedi (#${video.id}): ${telegram.escapeHtml(task.failMsg || 'bilinmeyen hata')}`)
          .catch(() => {});
      }
    } else if (Date.now() - new Date(video.createdAt).getTime() > PENDING_TIMEOUT_MS) {
      await TiktokVideo.finish(video.id, { status: 'fail', error: 'Zaman aşımı (30 dk)', completedAt: new Date() });
    }
    return TiktokVideo.findById(id);
  } finally {
    refreshing.delete(id);
  }
}

// 14 günden eski klip dosyalarını siler; kayıt kalır, sadece dosya gider
async function cleanupOldFiles() {
  const rows = await TiktokVideo.findExpiredFiles(new Date(Date.now() - KEEP_FILES_MS));
  for (const row of rows) {
    await fs.promises.unlink(path.join(STORAGE_DIR, row.file_path)).catch(() => {});
    await TiktokVideo.update(row.id, { file_path: null });
  }
}

// Bekleyen klipleri tazeler; sayfa kapalıyken de video bitince Telegram bildirimi gider
async function refreshPending() {
  const pending = await TiktokVideo.findPending();
  for (const video of pending) {
    await refresh(video.id).catch((err) => console.error(`TikTok klip #${video.id} kontrol hatası:`, err.message));
  }
  await cleanupOldFiles().catch((err) => console.error('TikTok dosya temizliği hatası:', err.message));
  return pending.length;
}

// Bekleyen iş varken çalışan zamanlayıcı; iş bitince kendini kapatır
function ensurePoller() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const remaining = await refreshPending().catch(() => 1);
    if (remaining === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, POLL_MS);
}

async function start({ ideaId, ideaIndex, prompt, duration, resolution }) {
  const usage = await monthlyUsage();
  if (usage.used >= usage.limit) {
    const err = new Error(`Aylık kredi limiti doldu (${usage.used}/${usage.limit}). Ayarlar'dan limiti artırabilirsin.`);
    err.status = 403;
    throw err;
  }

  const model = await Setting.get('kie_video_model');
  const id = await TiktokVideo.create({
    idea_id: ideaId || null,
    idea_index: Number.isInteger(ideaIndex) ? ideaIndex : null,
    model,
    prompt,
    duration,
    resolution,
  });

  try {
    const taskId = await kie.createTask(model, { prompt, aspect_ratio: '9:16', duration, resolution });
    await TiktokVideo.update(id, { kie_task_id: taskId });
  } catch (err) {
    await TiktokVideo.update(id, { status: 'fail', error: String(err.message).slice(0, 500), completedAt: new Date() });
    throw err;
  }

  ensurePoller();
  return TiktokVideo.findById(id);
}

async function remove(id) {
  const video = await TiktokVideo.findById(id);
  if (!video) return false;
  if (video.file_path) await fs.promises.unlink(filePathOf(video)).catch(() => {});
  return TiktokVideo.remove(id);
}

// Açılışta yarım kalan işleri devral
async function resume() {
  try {
    if ((await refreshPending()) > 0) ensurePoller();
  } catch (err) {
    console.error('TikTok klip kontrolü başlatılamadı:', err.message);
  }
}

module.exports = { start, refresh, remove, monthlyUsage, resume, filePathOf };
