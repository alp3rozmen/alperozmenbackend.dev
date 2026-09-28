const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const instagramController = require('../controllers/instagram.controller');

// Memory storage, küçük/orta boy videolar için
const upload = multer({ storage: multer.memoryStorage() });

router.post('/login', auth, instagramController.login);
router.post('/2flogin', auth, instagramController.twoFactorLogin);
router.post('/add', auth, upload.fields([{ name: 'video' }, { name: 'cover' }]), instagramController.addVideo);

module.exports = router;
