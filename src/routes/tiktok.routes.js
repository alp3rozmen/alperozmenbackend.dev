const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const path = require('path');
const crypto = require('crypto');
const tiktokController = require('../controllers/tiktok.controller');
const { CLIPS_DIR } = require('../services/tiktok/render.service');

// Ürün fotoğrafları tarayıcıda küçültülüp gelir; yine de dosya başına 10MB sınır
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });

// Kendi çekimleri doğrudan diske yazılır (telefon videoları büyük); klip başına 150MB
const clipUpload = multer({
  storage: multer.diskStorage({
    destination: CLIPS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase() || '.mp4'}`),
  }),
  limits: { fileSize: 150 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('video/')),
});

// Multer hatalarını (boyut sınırı vb.) JSON mesaja çevirir
function receiveClips(req, res, next) {
  clipUpload.array('clips', 8)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Klip 150MB sınırını aşıyor; 1080p çekmeyi dene.' : err.message;
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message });
  });
}

router.get('/usage', auth, tiktokController.usage);
router.post('/ideas', auth, upload.fields([{ name: 'photos', maxCount: 4 }]), tiktokController.createIdeas);
router.get('/ideas', auth, tiktokController.listIdeas);
router.get('/ideas/:id', auth, tiktokController.getIdea);
router.delete('/ideas/:id', auth, tiktokController.removeIdea);
router.post('/videos', auth, tiktokController.createVideo);
router.get('/videos/:id', auth, tiktokController.getVideo);
router.get('/videos/:id/file', auth, tiktokController.videoFile);
router.delete('/videos/:id', auth, tiktokController.removeVideo);

router.post('/ideas/:id/clips', auth, receiveClips, tiktokController.uploadClips);
router.patch('/clips/:id', auth, tiktokController.updateClip);
router.get('/clips/:id/file', auth, tiktokController.clipFile);
router.delete('/clips/:id', auth, tiktokController.removeClip);
router.post('/renders', auth, tiktokController.createRender);
router.get('/renders/:id', auth, tiktokController.getRender);
router.get('/renders/:id/file', auth, tiktokController.renderFile);
router.delete('/renders/:id', auth, tiktokController.removeRender);

// Fotoğraftan otomatik ürün videosu: ön yüz zorunlu, arka yüz opsiyonel
router.post('/product-videos', auth, upload.fields([{ name: 'photos', maxCount: 2 }]), tiktokController.createProductVideo);
router.get('/product-videos', auth, tiktokController.listProductVideos);
router.get('/product-videos/:id', auth, tiktokController.getProductVideo);
router.get('/product-videos/:id/file', auth, tiktokController.productVideoFile);
router.post('/product-videos/:id/publish', auth, tiktokController.publishProductVideo);
router.delete('/product-videos/:id', auth, tiktokController.removeProductVideo);

module.exports = router;
