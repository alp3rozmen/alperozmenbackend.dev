const router = require('express').Router();
const auth = require('../middleware/auth');
const mhrsController = require('../controllers/mhrs.controller');

router.post('/searchandclaim', auth, mhrsController.searchAndClaim);

module.exports = router;
