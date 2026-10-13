const scanner = require('../services/crypto/scanner.service');
const telegram = require('../services/telegram');

const OPTION_KEYS = ['binanceTrOnly', 'statusReports'];

// Panel checkbox'ları; gönderilmeyen seçenek değişmez
function pickOptions(body = {}) {
  const values = {};
  for (const key of OPTION_KEYS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { error: `${key} true/false olmalı` };
    values[key] = body[key];
  }
  return { values };
}

// Panelden sadece mum aralığı ve iki seçenek seçilir; diğer ayarlar backtest edilmiş varsayılanlardan gelir
exports.start = async (req, res) => {
  const timeframe = req.body?.timeframe;
  if (timeframe !== undefined && !scanner.TIMEFRAME_PRESETS[timeframe]) {
    return res.status(400).json({ message: `Mum aralığı şunlardan biri olmalı: ${Object.keys(scanner.TIMEFRAME_PRESETS).join(', ')}` });
  }
  const options = pickOptions(req.body);
  if (options.error) return res.status(400).json({ message: options.error });
  try {
    const settings = await scanner.start({ timeframe, ...options.values });
    res.json({ message: 'Kripto tarayıcı başlatıldı', settings });
  } catch (err) {
    res.status(500).json({ message: 'Başlatılamadı', error: err.message });
  }
};

exports.options = async (req, res) => {
  const options = pickOptions(req.body);
  if (options.error) return res.status(400).json({ message: options.error });
  try {
    const settings = await scanner.setOptions(options.values);
    res.json({ message: 'Ayar kaydedildi', settings });
  } catch (err) {
    res.status(500).json({ message: 'Ayar kaydedilemedi', error: err.message });
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

// --- Gerçek hesap (yarı otomatik: alımlar kullanıcı onayıyla) ---

const trader = require('../services/crypto/trader.service');

function tradingFail(res, err, message) {
  console.error(message + ':', err.message);
  res.status(err.status || 500).json({ message, error: String(err.message).slice(0, 500) });
}

exports.tradingStatus = async (req, res) => {
  try {
    res.json(await trader.status());
  } catch (err) {
    tradingFail(res, err, 'Gerçek hesap durumu alınamadı');
  }
};

exports.tradingConfig = async (req, res) => {
  const body = req.body || {};
  const changes = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled true/false olmalı' });
    changes.enabled = body.enabled;
  }
  if (body.capitalUsdt !== undefined) {
    const capital = Number(body.capitalUsdt);
    if (!Number.isFinite(capital) || capital < 0) return res.status(400).json({ message: 'Sermaye geçerli bir sayı olmalı' });
    changes.capitalUsdt = capital;
  }
  if (body.riskProfile !== undefined) {
    if (!trader.PROFILES[body.riskProfile]) return res.status(400).json({ message: 'Geçersiz risk profili' });
    changes.riskProfile = body.riskProfile;
  }
  if (body.allIn !== undefined) {
    if (typeof body.allIn !== 'boolean') return res.status(400).json({ message: 'allIn true/false olmalı' });
    // All-in'i yanlışlıkla açmamak için panel açık onay gönderir
    if (body.allIn && body.confirmAllIn !== true) return res.status(400).json({ message: 'All-in için açık onay (confirmAllIn) gerekli' });
    changes.allIn = body.allIn;
  }
  if (body.newsMode !== undefined) {
    if (!trader.NEWS_MODES.includes(body.newsMode)) return res.status(400).json({ message: 'Geçersiz haber modu' });
    changes.newsMode = body.newsMode;
  }
  try {
    res.json({ message: 'Kaydedildi', config: await trader.saveConfig(changes) });
  } catch (err) {
    tradingFail(res, err, 'Ayar kaydedilemedi');
  }
};

exports.tradingTest = async (req, res) => {
  try {
    const { usdt } = await trader.testConnection();
    res.json({ message: `Bağlantı çalışıyor. Kullanılabilir bakiye: ${usdt.toFixed(2)} USDT` });
  } catch (err) {
    tradingFail(res, err, 'Gate.io bağlantısı başarısız');
  }
};

exports.tradeApprove = async (req, res) => {
  try {
    const trade = await trader.approve(Number(req.params.id));
    res.json({ message: `Alındı: ${trade.pair.replace('_USDT', '')}`, trade });
  } catch (err) {
    tradingFail(res, err, 'Alınmadı');
  }
};

exports.tradeReject = async (req, res) => {
  try {
    await trader.reject(Number(req.params.id));
    res.json({ message: 'Öneri geçildi' });
  } catch (err) {
    tradingFail(res, err, 'Geçilemedi');
  }
};

exports.tradeSell = async (req, res) => {
  try {
    await trader.sell(Number(req.params.id));
    res.json({ message: 'Satıldı' });
  } catch (err) {
    tradingFail(res, err, 'Satılamadı');
  }
};

exports.tradingCloseAll = async (req, res) => {
  try {
    const count = await trader.closeAll();
    res.json({ message: `Öneriler kapatıldı, ${count} pozisyon satıldı` });
  } catch (err) {
    tradingFail(res, err, 'Tümü satılamadı');
  }
};
