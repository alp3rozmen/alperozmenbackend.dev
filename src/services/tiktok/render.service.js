const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const telegram = require('../telegram');
const videoService = require('./video.service');
const { ideaItem, buildCaption } = require('./caption');
const TiktokClip = require('../../models/TiktokClip');
const TiktokRender = require('../../models/TiktokRender');
const TiktokVideo = require('../../models/TiktokVideo');

const STORAGE_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'tiktok');
const CLIPS_DIR = path.join(STORAGE_DIR, 'clips');
const RENDERS_DIR = path.join(STORAGE_DIR, 'renders');
const FONTS_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
const KEEP_FILES_MS = 14 * 24 * 3_600_000;

// Paylaşımlı hostingi yormamak için 720p, hızlı preset
const WIDTH = 720;
const HEIGHT = 1280;
const MAX_SPEED = 8;
const MAX_HOOK_SECONDS = 15;

const queue = [];
let working = false;
let cpuChain = Promise.resolve();

// ffmpeg işleri (bu kuyruk ve otomatik ürün videoları) sırayla çalışır; paylaşımlı hostingi kilitlemesin
function exclusive(fn) {
  const run = cpuChain.then(fn, fn);
  cpuChain = run.catch(() => {});
  return run;
}

fs.mkdirSync(CLIPS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

const clipPath = (clip) => path.join(CLIPS_DIR, clip.file_name);
const renderPath = (render) => path.join(RENDERS_DIR, render.file_path);

// atempo tek seferde en fazla 2x; daha hızlısı için zincirlenir
function atempoChain(speed) {
  const parts = [];
  let rest = speed;
  while (rest > 2) {
    parts.push('atempo=2');
    rest /= 2;
  }
  parts.push(`atempo=${rest.toFixed(4)}`);
  return parts.join(',');
}

// Her parçayı aynı formata (720x1280, 30fps, stereo AAC) çevirir ki sonra kopyalanarak birleştirilebilsin
async function normalizeSegment({ file, hasAudio, speed, outSeconds }, target) {
  const inputSeconds = outSeconds * speed;
  const video = `setpts=PTS/${speed},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${WIDTH}:${HEIGHT},fps=30,format=yuv420p`;
  const args = ['-t', inputSeconds.toFixed(3), '-i', file];
  let audioMap;
  if (hasAudio) {
    args.push('-filter_complex',
      `[0:v]${video}[v];[0:a]${speed === 1 ? 'anull' : atempoChain(speed)},aresample=44100,aformat=channel_layouts=stereo[a]`);
    audioMap = '[a]';
  } else {
    // Sessiz klibe boş ses izi eklenir; birleştirmede bütün parçaların ses izi olmalı
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-filter_complex', `[0:v]${video}[v]`);
    audioMap = '1:a';
  }
  args.push(
    '-map', '[v]', '-map', audioMap, '-t', outSeconds.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', target
  );
  await ffmpeg.run(args);
}

// Fotoğraftan ücretsiz sahne (Ken Burns): fotoğraf kesilmeden ortalanır, arkası bulanık kopyasıyla dolar,
// yavaşça yakınlaşır ('in') veya uzaklaşır ('out'). Birleştirme için sessiz ses izi eklenir.
async function photoSegment({ file, effect, outSeconds }, target) {
  const frames = Math.round(outSeconds * 30);
  const zoom = effect === 'out'
    ? `max(1.15-0.15*on/${frames - 1},1)`
    : `min(1+0.15*on/${frames - 1},1.15)`;
  const video = `[0:v]split[a][b];` +
    `[a]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=30:3[bg];` +
    `[b]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
    // Titremeyi azaltmak için zoompan iki kat çözünürlükte çalışır
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,scale=${WIDTH * 2}:${HEIGHT * 2},` +
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=30,format=yuv420p[v]`;
  await ffmpeg.run([
    '-i', file, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', video, '-map', '[v]', '-map', '1:a', '-t', outSeconds.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', target,
  ]);
}

// Fontta emoji yok (kutu çıkar); ASS'in özel karakterleri de temizlenir
function assEscape(text) {
  return String(text)
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[{}\\]/g, '')
    .replace(/\s+\r?\n|\r?\n/g, '\\N')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// Yazılar dikeyde ortada (üstte ürünün/karakterin yüzünü kapatıyordu); sağ marj TikTok butonlarına denk gelmesin diye geniş
function buildAss(events) {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Hook,Noto Sans Black,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,5,2,5,70,90,0,1',
    'Style: Text,Noto Sans Black,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,4,2,5,70,90,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${assEscape(e.text)}`);
  return [...header, ...lines, ''].join('\n');
}

// Hook yazısı açılışta; ekran yazıları kendi kliplerinin süresine eşit dağıtılır
function subtitleEvents(item, hookSeconds, totalSeconds) {
  if (!item) return [];
  const events = [];
  const hookEnd = hookSeconds > 0 ? hookSeconds : Math.min(3, totalSeconds);
  events.push({ start: 0, end: hookEnd, style: 'Hook', text: item.hookText });

  const texts = item.onScreenTexts || [];
  const span = totalSeconds - hookEnd;
  if (texts.length && span > 0.5) {
    const slice = span / texts.length;
    texts.forEach((text, i) => {
      events.push({ start: hookEnd + i * slice, end: hookEnd + (i + 1) * slice - 0.1, style: 'Text', text });
    });
  }
  return events;
}

async function planSegments(render) {
  const segments = [];
  if (render.hook_video_id) {
    const hook = await TiktokVideo.findById(render.hook_video_id);
    if (hook?.file_path) {
      const file = videoService.filePathOf(hook);
      const info = await ffmpeg.probe(file);
      segments.push({ file, hasAudio: info.hasAudio, speed: 1, outSeconds: Math.min(info.duration, MAX_HOOK_SECONDS), isHook: true });
    }
  }
  const clips = await TiktokClip.listByIdea(render.idea_id, render.idea_index);
  for (const clip of clips) {
    const duration = Number(clip.duration);
    const target = Number(clip.target_seconds);
    // Uzun timelapse'ler hızlandırılır (en fazla 8x), sonra hedef süreye kırpılır
    const speed = Math.min(MAX_SPEED, Math.max(1, duration / target));
    segments.push({ file: clipPath(clip), hasAudio: !!clip.has_audio, speed, outSeconds: Math.min(duration / speed, target) });
  }
  return segments;
}

async function processRender(renderId) {
  const render = await TiktokRender.findById(renderId);
  if (!render || render.status !== 'pending') return;
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tiktok-render-${render.id}-`));

  try {
    const segments = await planSegments(render);
    if (segments.length === 0) throw new Error('Birleştirilecek klip yok; hook klibi seç veya kendi videolarını yükle.');

    const parts = [];
    for (const [i, segment] of segments.entries()) {
      const target = path.join(work, `part-${i}.mp4`);
      await normalizeSegment(segment, target);
      parts.push(target);
    }

    const total = segments.reduce((sum, s) => sum + s.outSeconds, 0);
    const hookSeconds = segments[0].isHook ? segments[0].outSeconds : 0;
    const item = await ideaItem(render.idea_id, render.idea_index);
    const listFile = path.join(work, 'list.txt');
    const assFile = path.join(work, 'subs.ass');
    await fs.promises.writeFile(listFile, parts.map((p) => `file '${p}'`).join('\n'));
    await fs.promises.writeFile(assFile, buildAss(subtitleEvents(item, hookSeconds, total)));

    const fileName = `${render.id}.mp4`;
    await ffmpeg.run([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `ass=${assFile}:fontsdir=${FONTS_DIR}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart',
      path.join(RENDERS_DIR, fileName),
    ]);

    await TiktokRender.update(render.id, { status: 'success', file_path: fileName, duration: total, completedAt: new Date() });
    const caption = buildCaption(`✅ TikTok videon hazır (#${render.id}, ${total.toFixed(0)} sn)`, item);
    await telegram.sendVideo(path.join(RENDERS_DIR, fileName), caption)
      .catch((err) => console.error('Telegram video hatası:', err.response?.data?.description || err.message));
  } catch (err) {
    console.error(`TikTok render #${render.id} hatası:`, err.message);
    await TiktokRender.update(render.id, { status: 'fail', error: String(err.message).slice(0, 500), completedAt: new Date() });
    await telegram.sendMessage(`❌ TikTok videosu oluşturulamadı (#${render.id}): ${telegram.escapeHtml(err.message.slice(0, 300))}`)
      .catch(() => {});
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

// Render'lar CPU yoğun; aynı anda tek tane çalışır
async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      await exclusive(() => processRender(id));
    }
    await cleanup().catch((err) => console.error('TikTok dosya temizliği hatası:', err.message));
  } finally {
    working = false;
  }
}

function enqueue(renderId) {
  if (!queue.includes(renderId)) queue.push(renderId);
  drain();
}

async function start({ ideaId, ideaIndex, hookVideoId }) {
  const id = await TiktokRender.create({ idea_id: ideaId, idea_index: ideaIndex, hook_video_id: hookVideoId || null });
  enqueue(id);
  return TiktokRender.findById(id);
}

async function addClip(file, { ideaId, ideaIndex }) {
  try {
    const info = await ffmpeg.probe(file.path);
    const id = await TiktokClip.create({
      idea_id: ideaId,
      idea_index: ideaIndex,
      file_name: path.basename(file.path),
      original_name: String(file.originalname || '').slice(0, 255),
      duration: info.duration,
      has_audio: info.hasAudio ? 1 : 0,
      target_seconds: Math.min(4, Math.max(1, Math.round(info.duration))),
      sort_order: await TiktokClip.nextSortOrder(ideaId, ideaIndex),
    });
    return TiktokClip.findById(id);
  } catch (err) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw err;
  }
}

async function removeClip(id) {
  const clip = await TiktokClip.findById(id);
  if (!clip) return false;
  await fs.promises.unlink(clipPath(clip)).catch(() => {});
  return TiktokClip.remove(id);
}

async function removeRender(id) {
  const render = await TiktokRender.findById(id);
  if (!render) return false;
  if (render.file_path) await fs.promises.unlink(renderPath(render)).catch(() => {});
  return TiktokRender.remove(id);
}

// 14 günden eski yüklemeler ve son videolar silinir (disk şişmesin)
async function cleanup() {
  const before = new Date(Date.now() - KEEP_FILES_MS);
  for (const clip of await TiktokClip.findOlderThan(before)) await removeClip(clip.id);
  for (const row of await TiktokRender.findExpiredFiles(before)) {
    await fs.promises.unlink(path.join(RENDERS_DIR, row.file_path)).catch(() => {});
    await TiktokRender.update(row.id, { file_path: null });
  }
}

// Açılışta yarım kalan render'ları kuyruğa geri al
async function resume() {
  try {
    await cleanup();
    for (const render of await TiktokRender.findPending()) enqueue(render.id);
  } catch (err) {
    console.error('TikTok render kuyruğu başlatılamadı:', err.message);
  }
}

module.exports = { CLIPS_DIR, FONTS_DIR, exclusive, normalizeSegment, photoSegment, buildAss, start, addClip, removeClip, removeRender, renderPath, resume, cleanup };
