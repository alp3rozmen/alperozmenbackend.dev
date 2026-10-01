const fs = require('fs');
const gemini = require('../services/tiktok/gemini');
const videoService = require('../services/tiktok/video.service');
const TiktokIdea = require('../models/TiktokIdea');
const TiktokVideo = require('../models/TiktokVideo');

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
    res.status(201).json({ ...(await TiktokIdea.findById(id)), videos: [] });
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
    res.json({ ...idea, videos: await TiktokVideo.listByIdea(idea.id) });
  } catch (err) {
    fail(res, err, 'Fikir alınamadı');
  }
};

exports.removeIdea = async (req, res) => {
  try {
    const id = Number(req.params.id);
    for (const video of await TiktokVideo.listByIdea(id)) await videoService.remove(video.id);
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
