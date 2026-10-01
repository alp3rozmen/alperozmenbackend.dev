const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const tiktokController = require('../controllers/tiktok.controller');

// Ürün fotoğrafları tarayıcıda küçültülüp gelir; yine de dosya başına 10MB sınır
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });

router.get('/usage', auth, tiktokController.usage);
router.post('/ideas', auth, upload.fields([{ name: 'photos', maxCount: 4 }]), tiktokController.createIdeas);
router.get('/ideas', auth, tiktokController.listIdeas);
router.get('/ideas/:id', auth, tiktokController.getIdea);
router.delete('/ideas/:id', auth, tiktokController.removeIdea);
router.post('/videos', auth, tiktokController.createVideo);
router.get('/videos/:id', auth, tiktokController.getVideo);
router.get('/videos/:id/file', auth, tiktokController.videoFile);
router.delete('/videos/:id', auth, tiktokController.removeVideo);

module.exports = router;
