const router = require('express').Router();
const auth = require('../middleware/auth');
const settingsController = require('../controllers/settings.controller');

router.get('/', auth, settingsController.list);
router.put('/', auth, settingsController.update);

module.exports = router;
