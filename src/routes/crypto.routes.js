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

router.get('/status', auth, cryptoController.status);
router.get('/signals', auth, cryptoController.signals);
router.post('/start', auth, cryptoController.start);
router.post('/stop', auth, cryptoController.stop);
router.post('/options', auth, cryptoController.options);
router.post('/tick', cronOrAuth, cryptoController.tick);
router.post('/telegram/test', auth, cryptoController.telegramTest);
router.get('/telegram/chats', auth, cryptoController.telegramChats);

module.exports = router;
