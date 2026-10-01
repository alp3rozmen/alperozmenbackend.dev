const scanner = require('../services/crypto/scanner.service');
const telegram = require('../services/telegram');
const CryptoSignal = require('../models/CryptoSignal');

// Body'den sadece bilinen ayarları al; timeframe dışındakiler sayı olmalı
function pickSettings(body = {}) {
  const result = {};
  for (const key of Object.keys(scanner.DEFAULT_SETTINGS)) {
    if (body[key] === undefined) continue;
    if (key === 'timeframe') {
      if (['5m', '15m', '30m', '1h', '4h'].includes(body[key])) result[key] = body[key];
      continue;
    }
    const value = Number(body[key]);
    if (Number.isFinite(value) && value > 0) result[key] = value;
  }
  if (result.intervalMin) result.intervalMin = Math.max(1, result.intervalMin);
  return result;
}

exports.start = async (req, res) => {
  try {
    const settings = await scanner.start(pickSettings(req.body));
    res.json({ message: 'Kripto tarayıcı başlatıldı', settings });
  } catch (err) {
    res.status(500).json({ message: 'Başlatılamadı', error: err.message });
  }
};

exports.stop = async (req, res) => {
  try {
    await scanner.stop();
    res.json({ message: 'Kripto tarayıcı durduruldu' });
  } catch (err) {
    res.status(500).json({ message: 'Durdurulamadı', error: err.message });
  }
};

// Harici cron ile tek tur tarama (ör. cPanel cron: her 5 dk curl -X POST .../api/crypto/tick)
exports.tick = async (req, res) => {
  try {
    res.json(await scanner.tick());
  } catch (err) {
    res.status(500).json({ message: 'Tarama hatası', error: err.message });
  }
};

exports.status = async (req, res) => {
  try {
    res.json(await scanner.status());
  } catch (err) {
    res.status(500).json({ message: 'Durum alınamadı', error: err.message });
  }
};

exports.signals = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await CryptoSignal.list({ status: req.query.status, limit }));
  } catch (err) {
    res.status(500).json({ message: 'Sinyaller alınamadı', error: err.message });
  }
};

exports.telegramTest = async (req, res) => {
  try {
    const sent = await telegram.sendMessage('✅ Kripto tarayıcı Telegram bağlantısı çalışıyor.');
    if (!sent) return res.status(400).json({ message: 'Telegram bot token veya chat id eksik (Ayarlar sayfası)' });
    res.json({ message: 'Test mesajı gönderildi' });
  } catch (err) {
    res.status(500).json({ message: 'Telegram hatası', error: err.response?.data?.description || err.message });
  }
};

// Bota /start yazdıktan sonra chat id'yi bulmak için
exports.telegramChats = async (req, res) => {
  try {
    res.json(await telegram.listChats());
  } catch (err) {
    res.status(500).json({ message: 'Telegram hatası', error: err.response?.data?.description || err.message });
  }
};
