const router = require('express').Router();
const auth = require('../middleware/auth');
const crypto = require('crypto');
const cryptoController = require('../controllers/crypto.controller');
const Setting = require('../models/Setting');

// Cron JWT taşıyamayacağı için /tick, x-cron-key başlığı cron anahtarı ile eşleşirse de kabul edilir
async function cronOrAuth(req, res, next) {
  const expected = Buffer.from((await Setting.get('crypto_cron_key')) || '');
  const given = Buffer.from(String(req.headers['x-cron-key'] || ''));
  if (expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    return next();
  }
  return auth(req, res, next);
}

// Panel durumu eski kalmasın (tarayıcı/proxy önbelleği): GET yanıtları önbelleğe alınmaz
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 'no-store');
  next();
});

router.get('/status', auth, cryptoController.status);
router.get('/signals', auth, cryptoController.signals);
router.get('/logs', auth, cryptoController.logs);
router.delete('/logs', auth, cryptoController.clearLogs);
router.get('/logs/settings', auth, cryptoController.logSettings);
router.post('/logs/settings', auth, cryptoController.updateLogSettings);
router.post('/start', auth, cryptoController.start);
router.post('/stop', auth, cryptoController.stop);
router.post('/options', auth, cryptoController.options);
router.post('/tick', cronOrAuth, cryptoController.tick);
router.post('/telegram/test', auth, cryptoController.telegramTest);
router.get('/telegram/chats', auth, cryptoController.telegramChats);

// Gerçek hesap (Gate.io): alım sadece onayla; satış sadece kullanıcı isteğiyle (stop/hedef borsada)
router.get('/trading', auth, cryptoController.tradingStatus);
router.post('/trading/config', auth, cryptoController.tradingConfig);
router.post('/trading/test', auth, cryptoController.tradingTest);
router.post('/trading/close-all', auth, cryptoController.tradingCloseAll);
router.post('/trades/:id/approve', auth, cryptoController.tradeApprove);
router.post('/trades/:id/reject', auth, cryptoController.tradeReject);
router.post('/trades/:id/sell', auth, cryptoController.tradeSell);

module.exports = router;
