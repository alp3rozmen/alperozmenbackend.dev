const fs = require('fs');
const gemini = require('../services/tiktok/gemini');
const videoService = require('../services/tiktok/video.service');
const TiktokIdea = require('../models/TiktokIdea');
const TiktokVideo = require('../models/TiktokVideo');
const TiktokClip = require('../models/TiktokClip');
const TiktokRender = require('../models/TiktokRender');
const renderService = require('../services/tiktok/render.service');

const DURATIONS = [6, 8, 10, 15];
const RESOLUTIONS = ['480p', '720p'];

function fail(res, err, message) {
  console.error(message + ':', err.message);
  res.status(err.status || 500).json({ message, error: String(err.message).slice(0, 500) });
}

exports.createIdeas = async (req, res) => {
  const productName = String(req.body.productName || '').trim().slice(0, 200);
  if (!productName) return res.status(400).json({ message: 'Ürün adı gerekli.' });
  const notes = String(req.body.notes || '').slice(0, 2000);
  const count = Math.min(Math.max(Number(req.body.count) || 3, 1), 5);
  const photos = (req.files?.photos || []).filter((f) => f.mimetype.startsWith('image/'));

  try {
    const result = await gemini.generateIdeas({ productName, notes, photos, count });
    const id = await TiktokIdea.create({ productName, notes, ...result });
    res.status(201).json({ ...(await TiktokIdea.findById(id)), videos: [], clips: [], renders: [] });
  } catch (err) {
    fail(res, err, 'Fikirler üretilemedi');
  }
};

exports.listIdeas = async (req, res) => {
  try {
    res.json(await TiktokIdea.list());
  } catch (err) {
    fail(res, err, 'Fikirler alınamadı');
  }
};

exports.getIdea = async (req, res) => {
  try {
    const idea = await TiktokIdea.findById(Number(req.params.id));
    if (!idea) return res.status(404).json({ message: 'Fikir bulunamadı.' });
    res.json({
      ...idea,
      videos: await TiktokVideo.listByIdea(idea.id),
      clips: await TiktokClip.listByIdea(idea.id),
      renders: await TiktokRender.listByIdea(idea.id),
    });
  } catch (err) {
    fail(res, err, 'Fikir alınamadı');
  }
};

exports.removeIdea = async (req, res) => {
  try {
    const id = Number(req.params.id);
    for (const video of await TiktokVideo.listByIdea(id)) await videoService.remove(video.id);
    for (const clip of await TiktokClip.listByIdea(id)) await renderService.removeClip(clip.id);
    for (const render of await TiktokRender.listByIdea(id)) await renderService.removeRender(render.id);
    const removed = await TiktokIdea.remove(id);
    if (!removed) return res.status(404).json({ message: 'Fikir bulunamadı.' });
    res.json({ message: 'Fikir silindi.' });
  } catch (err) {
    fail(res, err, 'Fikir silinemedi');
  }
};

exports.createVideo = async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 5000);
  const duration = Number(req.body.duration);
  const resolution = String(req.body.resolution || '');
  if (!prompt) return res.status(400).json({ message: 'Prompt gerekli.' });
  if (!DURATIONS.includes(duration)) return res.status(400).json({ message: `Süre şunlardan biri olmalı: ${DURATIONS.join(', ')}` });
  if (!RESOLUTIONS.includes(resolution)) return res.status(400).json({ message: `Çözünürlük: ${RESOLUTIONS.join(', ')}` });

  try {
    const video = await videoService.start({
      ideaId: Number(req.body.ideaId) || null,
      ideaIndex: Number.isInteger(req.body.ideaIndex) ? req.body.ideaIndex : null,
      prompt,
      duration,
      resolution,
    });
    res.status(201).json(video);
  } catch (err) {
    fail(res, err, 'Klip üretimi başlatılamadı');
  }
};

exports.getVideo = async (req, res) => {
  try {
    const video = await videoService.refresh(Number(req.params.id));
    if (!video) return res.status(404).json({ message: 'Klip bulunamadı.' });
    res.json(video);
  } catch (err) {
    fail(res, err, 'Klip durumu alınamadı');
  }
};

exports.videoFile = async (req, res) => {
  try {
    const video = await TiktokVideo.findById(Number(req.params.id));
    if (!video?.file_path) return res.status(404).json({ message: 'Dosya yok (henüz hazır değil veya 14 günü geçtiği için silindi).' });
    const filePath = videoService.filePathOf(video);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Dosya bulunamadı.' });
    res.set('Content-Type', 'video/mp4');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    fail(res, err, 'Dosya alınamadı');
  }
};

exports.removeVideo = async (req, res) => {
  try {
    const removed = await videoService.remove(Number(req.params.id));
    if (!removed) return res.status(404).json({ message: 'Klip bulunamadı.' });
    res.json({ message: 'Klip silindi.' });
  } catch (err) {
    fail(res, err, 'Klip silinemedi');
  }
};

exports.usage = async (req, res) => {
  try {
    res.json(await videoService.monthlyUsage());
  } catch (err) {
    fail(res, err, 'Kullanım alınamadı');
  }
};

// --- Kendi çekimleri ve birleştirme ---

const MAX_CLIPS = 8;

exports.uploadClips = async (req, res) => {
  const ideaId = Number(req.params.id);
  const ideaIndex = Number(req.body.ideaIndex);
  const files = req.files || [];
  const cleanupFiles = () => Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));

  try {
    const idea = await TiktokIdea.findById(ideaId);
    if (!idea || !Number.isInteger(ideaIndex) || !idea.ideas[ideaIndex]) {
      await cleanupFiles();
      return res.status(404).json({ message: 'Fikir bulunamadı.' });
    }
    const existing = await TiktokClip.listByIdea(ideaId, ideaIndex);
    if (existing.length + files.length > MAX_CLIPS) {
      await cleanupFiles();
      return res.status(400).json({ message: `Bir fikre en fazla ${MAX_CLIPS} klip yüklenebilir.` });
    }

    const added = [];
    const errors = [];
    for (const file of files) {
      try {
        added.push(await renderService.addClip(file, { ideaId, ideaIndex }));
      } catch (err) {
        errors.push(`${file.originalname}: ${err.message}`);
      }
    }
    res.status(added.length ? 201 : 400).json({ clips: added, errors });
  } catch (err) {
    await cleanupFiles();
    fail(res, err, 'Klipler yüklenemedi');
  }
};

exports.updateClip = async (req, res) => {
  try {
    const clip = await TiktokClip.findById(Number(req.params.id));
    if (!clip) return res.status(404).json({ message: 'Klip bulunamadı.' });
    const fields = {};
    const target = Number(req.body.targetSeconds);
    if (Number.isFinite(target)) fields.target_seconds = Math.min(15, Math.max(1, target));
    if (Number.isInteger(req.body.sortOrder)) fields.sort_order = req.body.sortOrder;
    if (Object.keys(fields).length) await TiktokClip.update(clip.id, fields);
    res.json(await TiktokClip.findById(clip.id));
  } catch (err) {
    fail(res, err, 'Klip güncellenemedi');
  }
};

exports.removeClip = async (req, res) => {
  try {
    const removed = await renderService.removeClip(Number(req.params.id));
    if (!removed) return res.status(404).json({ message: 'Klip bulunamadı.' });
    res.json({ message: 'Klip silindi.' });
  } catch (err) {
    fail(res, err, 'Klip silinemedi');
  }
};

exports.clipFile = async (req, res) => {
  try {
    const clip = await TiktokClip.findById(Number(req.params.id));
    if (!clip) return res.status(404).json({ message: 'Klip bulunamadı.' });
    res.sendFile(clip.file_name, { root: renderService.CLIPS_DIR, headers: { 'Content-Type': 'video/mp4' } });
  } catch (err) {
    fail(res, err, 'Klip alınamadı');
  }
};

exports.createRender = async (req, res) => {
  const ideaId = Number(req.body.ideaId);
  const ideaIndex = Number(req.body.ideaIndex);
  try {
    const idea = await TiktokIdea.findById(ideaId);
    if (!idea || !Number.isInteger(ideaIndex) || !idea.ideas[ideaIndex]) return res.status(404).json({ message: 'Fikir bulunamadı.' });
    let hookVideoId = Number(req.body.hookVideoId) || null;
    if (hookVideoId) {
      const hook = await TiktokVideo.findById(hookVideoId);
      if (!hook?.file_path) return res.status(400).json({ message: 'Seçilen hook klibinin dosyası yok.' });
    }
    const clips = await TiktokClip.listByIdea(ideaId, ideaIndex);
    if (!hookVideoId && clips.length === 0) return res.status(400).json({ message: 'Önce hook klibi üret veya kendi videolarını yükle.' });
    res.status(201).json(await renderService.start({ ideaId, ideaIndex, hookVideoId }));
  } catch (err) {
    fail(res, err, 'Video oluşturma başlatılamadı');
  }
};

exports.getRender = async (req, res) => {
  try {
    const render = await TiktokRender.findById(Number(req.params.id));
    if (!render) return res.status(404).json({ message: 'Video bulunamadı.' });
    res.json(render);
  } catch (err) {
    fail(res, err, 'Video durumu alınamadı');
  }
};

exports.renderFile = async (req, res) => {
  try {
    const render = await TiktokRender.findById(Number(req.params.id));
    if (!render?.file_path) return res.status(404).json({ message: 'Dosya yok (henüz hazır değil veya 14 günü geçtiği için silindi).' });
    res.sendFile(renderService.renderPath(render), { headers: { 'Content-Type': 'video/mp4' } });
  } catch (err) {
    fail(res, err, 'Dosya alınamadı');
  }
};

exports.removeRender = async (req, res) => {
  try {
    const removed = await renderService.removeRender(Number(req.params.id));
    if (!removed) return res.status(404).json({ message: 'Video bulunamadı.' });
    res.json({ message: 'Video silindi.' });
  } catch (err) {
    fail(res, err, 'Video silinemedi');
  }
};
