const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const kie = require('./kie.api');
const gemini = require('./gemini');
const ffmpeg = require('./ffmpeg');
const telegram = require('../telegram');
const instagram = require('../instagram.graph');
const renderService = require('./render.service');
const videoService = require('./video.service');
const { buildCaption } = require('./caption');
const ProductVideo = require('../../models/ProductVideo');

// Fotoğraf → Gemini senaryosu → 3 Grok sahnesi → ffmpeg ile birleştirme + Türkçe yazılar → Telegram (+ Instagram)
const MODEL = 'grok-imagine/image-to-video'; // 7'ye kadar referans fotoğraf alır (@image1, @image2)
const SCENE_SECONDS = 6;
const RESOLUTION = '720p';
const HOOK_SECONDS = 2.5;
const POLL_MS = 20_000;
const PENDING_TIMEOUT_MS = 30 * 60_000;
const KEEP_FILES_MS = 14 * 24 * 3_600_000;

const PRODUCT_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'tiktok', 'product');
fs.mkdirSync(PRODUCT_DIR, { recursive: true });

let pollTimer = null;
let polling = false;

const filePath = (name) => path.join(PRODUCT_DIR, name);
const short = (err) => String(err?.message || err).slice(0, 500);

// Telegram ve Instagram açıklamasında aynı içerik kullanılır
function captionItem(plan) {
  return { hookText: plan.hookText, caption: plan.caption, hashtags: plan.hashtags };
}

async function failVideo(id, message) {
  await ProductVideo.update(id, { status: 'fail', error: String(message).slice(0, 500), completedAt: new Date() });
  await telegram.sendMessage(`❌ Ürün videosu üretilemedi (#${id}): ${telegram.escapeHtml(String(message).slice(0, 300))}`)
    .catch(() => {});
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

// 1. adım: fotoğrafları yükle, senaryoyu yaz, 3 sahneyi kie.ai'de başlat
async function prepare(id, { productName, notes, photos }) {
  const urls = [];
  for (const [i, photo] of photos.entries()) {
    urls.push(await kie.uploadImage(photo.buffer, photo.mimetype, `product-${id}-${i + 1}.jpg`));
  }
  const plan = await gemini.generateProductPlan({ productName, notes, photos });
  await ProductVideo.update(id, { photos: urls, plan });

  const scenes = [];
  try {
    for (const scene of plan.scenes) {
      const taskId = await kie.createTask(MODEL, {
        image_urls: urls,
        prompt: scene.prompt,
        duration: String(SCENE_SECONDS),
        resolution: RESOLUTION,
        aspect_ratio: '9:16',
        mode: 'normal',
      });
      scenes.push({ taskId, state: 'pending' });
    }
  } finally {
    // Başlatılabilen sahneler kaydedilsin; kredileri sonra hesaba katılır
    await ProductVideo.update(id, { scenes });
  }
  await ProductVideo.update(id, { status: 'generating' });
  ensurePoller();
}

// 2. adım: sahnelerin durumunu kontrol et, bitenleri indir; hepsi bitince render'a gönder
async function checkScenes(video) {
  const scenes = video.scenes || [];
  for (const [i, scene] of scenes.entries()) {
    if (scene.state !== 'pending') continue;
    const task = await kie.getTask(scene.taskId);
    if (task.state === 'success' && task.urls[0]) {
      const name = `${video.id}-scene-${i + 1}.mp4`;
      await download(task.urls[0], filePath(name));
      Object.assign(scene, { state: 'success', file: name, credits: task.credits });
    } else if (task.state === 'fail') {
      Object.assign(scene, { state: 'fail', credits: task.credits, error: task.failMsg || 'Üretim başarısız' });
    }
  }

  const credits = scenes.reduce((sum, s) => sum + (Number(s.credits) || 0), 0);
  await ProductVideo.update(video.id, { scenes, credits });

  const failed = scenes.findIndex((s) => s.state === 'fail');
  if (failed >= 0) return failVideo(video.id, `Sahne ${failed + 1} üretilemedi: ${scenes[failed].error}`);
  if (scenes.length && scenes.every((s) => s.state === 'success')) {
    await ProductVideo.update(video.id, { status: 'rendering' });
    enqueueRender(video.id);
    return;
  }
  if (Date.now() - new Date(video.createdAt).getTime() > PENDING_TIMEOUT_MS) {
    await failVideo(video.id, 'Zaman aşımı (30 dk): kie.ai sahneleri bitiremedi');
  }
}

// Hook yazısı açılışta, her sahnenin yazısı kendi süresince (ilk sahnede hook'tan sonra)
function subtitleEvents(plan, durations) {
  const events = [{ start: 0, end: Math.min(HOOK_SECONDS, durations[0]), style: 'Hook', text: plan.hookText }];
  let t = 0;
  durations.forEach((d, i) => {
    const start = i === 0 ? Math.min(HOOK_SECONDS, d) : t;
    const text = plan.scenes[i]?.text;
    if (text && t + d - start > 0.8) events.push({ start, end: t + d - 0.1, style: 'Text', text });
    t += d;
  });
  return events;
}

// 3. adım: sahneleri 720x1280'e çevir, birleştir, yazıları ekle
async function render(id) {
  const video = await ProductVideo.findById(id);
  if (!video || video.status !== 'rendering') return;
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `product-video-${id}-`));
  try {
    const parts = [];
    const durations = [];
    for (const [i, scene] of video.scenes.entries()) {
      const file = filePath(scene.file);
      const info = await ffmpeg.probe(file);
      const outSeconds = Math.min(info.duration, SCENE_SECONDS);
      const target = path.join(work, `part-${i}.mp4`);
      await renderService.normalizeSegment({ file, hasAudio: info.hasAudio, speed: 1, outSeconds }, target);
      parts.push(target);
      durations.push(outSeconds);
    }

    const listFile = path.join(work, 'list.txt');
    const assFile = path.join(work, 'subs.ass');
    await fs.promises.writeFile(listFile, parts.map((p) => `file '${p}'`).join('\n'));
    await fs.promises.writeFile(assFile, renderService.buildAss(subtitleEvents(video.plan, durations)));

    const fileName = `${id}.mp4`;
    await ffmpeg.run([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `ass=${assFile}:fontsdir=${renderService.FONTS_DIR}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      // Instagram API edit list içeren MP4'leri "ERROR" ile reddediyor; ffmpeg AAC gecikmesi için varsayılan olarak yazar
      '-c:a', 'copy', '-movflags', '+faststart', '-use_editlist', '0',
      filePath(fileName),
    ]);

    const total = durations.reduce((a, b) => a + b, 0);
    await ProductVideo.update(id, {
      status: 'success',
      file_path: fileName,
      duration: total,
      completedAt: new Date(),
    });
    // Sahne dosyaları artık gereksiz
    for (const scene of video.scenes) await fs.promises.unlink(filePath(scene.file)).catch(() => {});

    const caption = buildCaption(`🎬 Ürün videosu hazır: ${video.product_name} (#${id}, ${total.toFixed(0)} sn)`, captionItem(video.plan));
    await telegram.sendVideo(filePath(fileName), caption)
      .catch((err) => console.error('Telegram video hatası:', err.response?.data?.description || err.message));

    // Instagram işlemesi dakikalar sürebilir; ffmpeg sırasını bekletmesin
    if (video.auto_publish) publish(id).catch(() => {});
  } catch (err) {
    console.error(`Ürün videosu #${id} render hatası:`, err.message);
    await failVideo(id, `Birleştirme hatası: ${short(err)}`);
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

function enqueueRender(id) {
  renderService.exclusive(() => render(id)).catch(() => {});
}

// Instagram Reels olarak paylaşır. Hata Telegram'a da yazılır.
async function publish(id) {
  const video = await ProductVideo.findById(id);
  if (!video || video.status !== 'success' || !video.file_path) throw new Error('Video hazır değil.');
  if (video.publish_status === 'pending') throw new Error('Paylaşım zaten sürüyor.');
  if (video.publish_status === 'published') throw new Error('Bu video zaten paylaşıldı.');

  await ProductVideo.update(id, { publish_status: 'pending', publish_error: null });
  try {
    // Site bot korumasının arkasında (Instagram'ın indiricisi doğrulama sayfasına takılır);
    // video bu yüzden kie.ai'nin herkese açık deposuna yüklenip oradan verilir (24 saat tutulur)
    // Eski render'larda edit list kalmış olabilir; yeniden kodlamadan temiz bir kopya çıkar
    const clean = path.join(os.tmpdir(), `product-video-${id}-ig.mp4`);
    let videoUrl;
    try {
      await ffmpeg.run(['-i', filePath(video.file_path), '-c', 'copy', '-movflags', '+faststart', '-use_editlist', '0', clean]);
      videoUrl = await kie.uploadFile(clean, 'video/mp4', `product-video-${id}.mp4`);
    } finally {
      await fs.promises.unlink(clean).catch(() => {});
    }
    const caption = `${video.plan.caption}\n\n${video.plan.hashtags.join(' ')}`;
    const mediaId = await instagram.publishReel({ videoUrl, caption });
    await ProductVideo.update(id, { publish_status: 'published', ig_media_id: mediaId });
    await telegram.sendMessage(`📸 Instagram'da paylaşıldı: ${telegram.escapeHtml(video.product_name)} (#${id})`).catch(() => {});
  } catch (err) {
    await ProductVideo.update(id, { publish_status: 'fail', publish_error: short(err) });
    await telegram.sendMessage(`⚠️ Instagram paylaşımı başarısız (#${id}): ${telegram.escapeHtml(short(err))}`).catch(() => {});
    throw err;
  }
}

async function pollOnce() {
  if (polling) return 1;
  polling = true;
  try {
    const generating = await ProductVideo.findByStatus('generating');
    for (const video of generating) {
      await checkScenes(video).catch((err) => console.error(`Ürün videosu #${video.id} kontrol hatası:`, err.message));
    }
    return generating.length;
  } finally {
    polling = false;
  }
}

function ensurePoller() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const remaining = await pollOnce().catch(() => 1);
    if (remaining === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, POLL_MS);
}

async function start({ productName, notes, photos, autoPublish }) {
  const usage = await videoService.monthlyUsage();
  if (usage.used >= usage.limit) {
    const err = new Error(`Aylık kredi limiti doldu (${usage.used}/${usage.limit}). Ayarlar'dan limiti artırabilirsin.`);
    err.status = 403;
    throw err;
  }
  const id = await ProductVideo.create({ product_name: productName, notes: notes || null, auto_publish: autoPublish ? 1 : 0 });
  // Uzun sürer (yükleme + Gemini); istek beklemesin, panel durumu sorgular
  prepare(id, { productName, notes, photos }).catch((err) => {
    console.error(`Ürün videosu #${id} hazırlık hatası:`, err.message);
    failVideo(id, short(err));
  });
  return ProductVideo.findById(id);
}

async function remove(id) {
  const video = await ProductVideo.findById(id);
  if (!video) return false;
  if (video.file_path) await fs.promises.unlink(filePath(video.file_path)).catch(() => {});
  for (const scene of video.scenes || []) if (scene.file) await fs.promises.unlink(filePath(scene.file)).catch(() => {});
  return ProductVideo.remove(id);
}

async function cleanup() {
  for (const row of await ProductVideo.findExpiredFiles(new Date(Date.now() - KEEP_FILES_MS))) {
    await fs.promises.unlink(filePath(row.file_path)).catch(() => {});
    await ProductVideo.update(row.id, { file_path: null });
  }
}

// Açılışta yarım kalan işleri devral. Hazırlık aşamasındakiler fotoğraflar bellekte olduğu için devam edemez.
async function resume() {
  try {
    for (const video of await ProductVideo.findByStatus('planning')) {
      await failVideo(video.id, 'Sunucu yeniden başladı, hazırlık yarım kaldı; tekrar dene.');
    }
    if ((await ProductVideo.findByStatus('generating')).length) ensurePoller();
    for (const video of await ProductVideo.findByStatus('rendering')) enqueueRender(video.id);
    await cleanup();
  } catch (err) {
    console.error('Ürün videoları devam ettirilemedi:', err.message);
  }
}

module.exports = { start, publish, remove, resume, filePath, PRODUCT_DIR };
