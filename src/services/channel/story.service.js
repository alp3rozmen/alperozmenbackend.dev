const fs = require('fs');
const path = require('path');
const axios = require('axios');
const kie = require('../tiktok/kie.api');
const IgAccount = require('../../models/IgAccount');
const ChannelVideo = require('../../models/ChannelVideo');

// Hikaye modu (dizi): sabit karakter kadrosu + sezon/bölüm hafızası.
// Karakterler yazıdan her seferinde farklı çizilmesin diye bir kere görselleri üretilir; her bölüm bu görseller
// referans verilerek Grok image-to-video ile üretilir (@image1 = 1. karakter ...).

const SEASON_EPISODES = 6;
const MAX_CAST = 4;
const IMAGE_MODEL = 'grok-imagine/text-to-image';
const IMAGE_POLL_MS = 5_000;
const IMAGE_TIMEOUT_MS = 4 * 60_000;

const CAST_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'channels', 'cast');
fs.mkdirSync(CAST_DIR, { recursive: true });

const castPath = (name) => path.join(CAST_DIR, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const generating = new Set(); // aynı hesabın görselleri aynı anda iki kez üretilmesin

// Sıradaki bölüm: sezonun son bölümü yayınlandıysa yeni sezon başlar.
// previous: aynı sezonun önceki bölümleri (eskiden yeniye), Gemini'ye hikaye hafızası olarak verilir.
async function nextEpisode(account) {
  const history = await ChannelVideo.storyIdeas(account.id, account.story_since);
  const last = history[0];
  if (last && last.episode < (last.total || SEASON_EPISODES)) {
    const previous = history.filter((idea) => idea.season === last.season).reverse();
    return { season: last.season, episode: last.episode + 1, total: last.total || SEASON_EPISODES, previous };
  }
  // Hiç bölüm yoksa ya da sezon bittiyse / "yeni sezon" dendiyse: önceki tüm bölümlerin sezonunun bir fazlası
  const lastAny = last || (await ChannelVideo.storyIdeas(account.id, null, 1))[0];
  return { season: lastAny ? lastAny.season + 1 : 1, episode: 1, total: SEASON_EPISODES, previous: [] };
}

// Panelden gelen kadroyu doğrular; açıklaması değişmeyen karakterin görseli korunur
function mergeCast(oldCast, input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('Karakter listesi geçersiz.'), { status: 400 });
  if (input.length > MAX_CAST) throw Object.assign(new Error(`En fazla ${MAX_CAST} karakter.`), { status: 400 });
  const removed = [];
  const cast = input.map((c, i) => {
    const name = String(c?.name || '').trim().slice(0, 40);
    const description = String(c?.description || '').trim().slice(0, 400);
    if (!name || !description) throw Object.assign(new Error('Her karakterin adı ve görünüş tarifi olmalı.'), { status: 400 });
    const old = oldCast[i];
    if (old?.image && old.description === description) return { ...old, name };
    if (old?.image) removed.push(old.image);
    return { name, description, image: null, imageStatus: null, imageError: null };
  });
  for (const old of oldCast.slice(input.length)) if (old.image) removed.push(old.image);
  return { cast, removed };
}

async function removeImages(names) {
  for (const name of names) await fs.promises.unlink(castPath(name)).catch(() => {});
}

// Model PNG ya da JPEG dönebilir; uzantı içerikten belirlenir (yüklerken doğru tür bildirilsin)
async function downloadImage(url, baseName) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  const data = Buffer.from(response.data);
  const name = `${baseName}.${data.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : 'jpg'}`;
  await fs.promises.writeFile(castPath(name), data);
  return name;
}

const mimeOf = (name) => (name.endsWith('.png') ? 'image/png' : 'image/jpeg');

// Tek karakterin referans görseli: düz arka plan, tam boy, önden; video modelinin karakteri tanıması için
async function generateImage(account, character, index, style) {
  const prompt = `Character reference image for an animated comedy series. ${style ? `Art style: ${style}. ` : ''}` +
    `Character "${character.name}": ${character.description}. Full body, front view, centered, expressive face, ` +
    'plain light gray background, no other characters, no text, no letters, no watermark.';
  const taskId = await kie.createTask(IMAGE_MODEL, { prompt, aspect_ratio: '9:16' });
  const started = Date.now();
  for (;;) {
    await sleep(IMAGE_POLL_MS);
    const task = await kie.getTask(taskId);
    if (task.state === 'success' && task.urls[0]) {
      return downloadImage(task.urls[0], `${account.id}-${index}-${Date.now()}`);
    }
    if (task.state === 'fail') throw new Error(task.failMsg || 'Görsel üretilemedi');
    if (Date.now() - started > IMAGE_TIMEOUT_MS) throw new Error('Zaman aşımı (4 dk)');
  }
}

// Görseli olmayan (ya da all=true ise tüm) karakterlerin görsellerini arka planda üretir; panel durumu sorgular
async function generateCastImages(accountId, { all = false } = {}) {
  if (generating.has(accountId)) throw Object.assign(new Error('Görseller zaten üretiliyor.'), { status: 409 });
  const account = await IgAccount.findById(accountId);
  if (!account) throw Object.assign(new Error('Hesap bulunamadı.'), { status: 404 });
  if (!account.story_cast.length) throw Object.assign(new Error('Önce karakter ekle.'), { status: 400 });

  const targets = account.story_cast.map((c, i) => i).filter((i) => all || !account.story_cast[i].image);
  if (!targets.length) return account;
  const cast = account.story_cast.map((c, i) => (targets.includes(i) ? { ...c, imageStatus: 'pending', imageError: null } : c));
  await IgAccount.update(accountId, { story_cast: cast });

  generating.add(accountId);
  (async () => {
    try {
      for (const i of targets) {
        // Panelden bu arada kadro değiştirildiyse güncel halin üstüne yaz
        const fresh = (await IgAccount.findById(accountId))?.story_cast || [];
        const character = fresh[i];
        if (!character || character.description !== cast[i].description) continue;
        try {
          const image = await generateImage(account, character, i, account.niche_brief?.visualStyle);
          const latest = (await IgAccount.findById(accountId)).story_cast;
          if (latest[i]?.image) await removeImages([latest[i].image]);
          latest[i] = { ...latest[i], image, imageStatus: 'ready', imageError: null };
          await IgAccount.update(accountId, { story_cast: latest });
        } catch (err) {
          const latest = (await IgAccount.findById(accountId)).story_cast;
          if (latest[i]) latest[i] = { ...latest[i], imageStatus: 'fail', imageError: String(err.message).slice(0, 200) };
          await IgAccount.update(accountId, { story_cast: latest });
        }
      }
    } finally {
      generating.delete(accountId);
    }
  })();
  return IgAccount.findById(accountId);
}

// Bölüm üretilebilir mi: en az bir karakter var ve hepsinin görseli diskte duruyor.
// Değilse kullanıcıya gösterilecek sebep döner, hazırsa null.
function castProblem(account) {
  if (!account.story_cast.length) return 'Hikaye modu için önce karakter ekle.';
  const missing = account.story_cast.find((c) => !c.image || !fs.existsSync(castPath(c.image)));
  if (missing) return `"${missing.name}" karakterinin görseli yok; Instagram Kanalları'ndan karakter görsellerini üret.`;
  return null;
}

// Her bölümde karakter görselleri kie.ai'ye yüklenir (ücretsiz, 24 saat tutulur); sırası @image numarasıdır
async function uploadCast(account) {
  const problem = castProblem(account);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const ready = account.story_cast;
  const urls = [];
  for (const [i, c] of ready.entries()) {
    const ext = path.extname(c.image);
    urls.push(await kie.uploadImage(await fs.promises.readFile(castPath(c.image)), mimeOf(c.image), `cast-${account.id}-${i + 1}${ext}`));
  }
  return urls;
}

module.exports = {
  SEASON_EPISODES, MAX_CAST, nextEpisode, mergeCast, removeImages, generateCastImages, uploadCast, castProblem, castPath, mimeOf,
};
