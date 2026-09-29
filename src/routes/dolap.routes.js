const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const dolapController = require('../controllers/dolap.controller');

// Fotoğraflar tarayıcıda küçültülüp gelir; yine de dosya başına 10MB sınır
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 8 } });
const photos = upload.fields([{ name: 'photos', maxCount: 6 }]);

router.post('/listing', auth, photos, dolapController.listing);
router.post('/image', auth, photos, dolapController.image);
router.get('/templates', auth, dolapController.listTemplates);
router.get('/templates/:id/image', auth, dolapController.templateImage);
router.post('/templates', auth, upload.single('template'), dolapController.createTemplate);
router.delete('/templates/:id', auth, dolapController.removeTemplate);

module.exports = router;
