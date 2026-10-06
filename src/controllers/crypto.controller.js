const scanner = require('../services/crypto/scanner.service');
const telegram = require('../services/telegram');

// Panelden sadece mum aralığı seçilir; diğer ayarlar backtest edilmiş varsayılanlardan gelir
exports.start = async (req, res) => {
  const timeframe = req.body?.timeframe;
  if (timeframe !== undefined && !scanner.TIMEFRAME_PRESETS[timeframe]) {
    return res.status(400).json({ message: `Mum aralığı şunlardan biri olmalı: ${Object.keys(scanner.TIMEFRAME_PRESETS).join(', ')}` });
  }
  try {
    const settings = await scanner.start({ timeframe });
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
    res.json(await scanner.listSignals({ status: req.query.status, limit }));
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
