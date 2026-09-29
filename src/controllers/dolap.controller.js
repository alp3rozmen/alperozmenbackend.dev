const dolapService = require('../services/dolap/dolap.service');
const DolapTemplate = require('../models/DolapTemplate');

function geminiError(err) {
  return err.message?.slice(0, 500) || 'Bilinmeyen hata';
}

function photosFrom(req) {
  return (req.files?.photos || []).filter((f) => f.mimetype.startsWith('image/'));
}

exports.listing = async (req, res) => {
  const photos = photosFrom(req);
  if (photos.length === 0) return res.status(400).json({ message: 'En az 1 ürün fotoğrafı gerekli.' });
  try {
    const listing = await dolapService.generateListing({
      photos,
      notes: String(req.body.notes || '').slice(0, 2000),
      grams: Number(req.body.grams) || null,
      printHours: Number(req.body.printHours) || null,
    });
    res.json(listing);
  } catch (err) {
    console.error('Dolap ilan metni hatası:', err.message);
    res.status(500).json({ message: 'İlan metni oluşturulamadı', error: geminiError(err) });
  }
};

exports.image = async (req, res) => {
  const photos = photosFrom(req);
  if (photos.length === 0) return res.status(400).json({ message: 'En az 1 ürün fotoğrafı gerekli.' });
  try {
    let template = null;
    if (req.body.templateId) {
      const row = await DolapTemplate.findById(Number(req.body.templateId));
      if (!row) return res.status(404).json({ message: 'Şablon bulunamadı.' });
      template = { mimetype: row.mime, buffer: row.image };
    }
    let listing = null;
    try {
      listing = req.body.listing ? JSON.parse(req.body.listing) : null;
    } catch {
      return res.status(400).json({ message: 'Geçersiz ilan verisi.' });
    }

    const image = await dolapService.generateImage({
      photos,
      template,
      listing,
      instructions: String(req.body.instructions || '').slice(0, 500),
    });
    res.json({ image: `data:${image.mimeType};base64,${image.data}` });
  } catch (err) {
    console.error('Dolap görsel hatası:', err.message);
    res.status(500).json({ message: 'Görsel oluşturulamadı', error: geminiError(err) });
  }
};

exports.listTemplates = async (req, res) => {
  try {
    res.json(await DolapTemplate.list());
  } catch (err) {
    res.status(500).json({ message: 'Şablonlar alınamadı.' });
  }
};

exports.templateImage = async (req, res) => {
  try {
    const row = await DolapTemplate.findById(Number(req.params.id));
    if (!row) return res.status(404).json({ message: 'Şablon bulunamadı.' });
    res.set('Content-Type', row.mime).send(row.image);
  } catch (err) {
    res.status(500).json({ message: 'Şablon alınamadı.' });
  }
};

exports.createTemplate = async (req, res) => {
  const file = req.file;
  if (!file || !file.mimetype.startsWith('image/')) return res.status(400).json({ message: 'Şablon görseli gerekli.' });
  const name = String(req.body.name || '').trim().slice(0, 100) || 'Şablon';
  try {
    const id = await DolapTemplate.create({ name, mime: file.mimetype, image: file.buffer });
    res.status(201).json({ id, name });
  } catch (err) {
    res.status(500).json({ message: 'Şablon kaydedilemedi.' });
  }
};

exports.removeTemplate = async (req, res) => {
  try {
    const removed = await DolapTemplate.remove(Number(req.params.id));
    if (!removed) return res.status(404).json({ message: 'Şablon bulunamadı.' });
    res.json({ message: 'Şablon silindi.' });
  } catch (err) {
    res.status(500).json({ message: 'Şablon silinemedi.' });
  }
};
