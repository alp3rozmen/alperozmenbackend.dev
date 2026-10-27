const router = require('express').Router();
const auth = require('../middleware/auth');
const mhrsController = require('../controllers/mhrs.controller');

router.post('/searchandclaim', auth, mhrsController.searchAndClaim);
router.get('/durum', auth, mhrsController.durum);
router.post('/durdur', auth, mhrsController.durdur);

module.exports = router;
