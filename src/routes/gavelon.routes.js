const router = require('express').Router();
const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const Gavelon = require('../models/Gavelon');
const controller = require('../controllers/gavelon.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

// Yalnızca bilinen varlık adları (universes, characters, ...) geçsin
router.param('entity', (req, res, next, entity) => (Gavelon.has(entity) ? next() : res.status(404).json({ message: 'Bilinmeyen içerik türü.' })));

// Herkese açık
router.get('/data', controller.publicData);
// Yerel geliştirmede yüklenen görseller buradan sunulur (üretimde statik klasörden)
router.use('/img', express.static(Gavelon.IMG_DIR, { maxAge: '7d', fallthrough: false }));

// Yönetim (JWT)
router.get('/admin/config', auth, controller.getConfig);
router.put('/admin/config', auth, controller.saveConfig);
router.get('/admin/validate', auth, controller.validate);
router.post('/admin/publish', auth, controller.publish);
router.post('/admin/upload', auth, (req, res, next) => upload.single('image')(req, res, (err) => (err ? res.status(400).json({ message: 'Dosya yüklenemedi (en fazla 2MB).' }) : next())), controller.upload);
router.get('/admin/:entity', auth, controller.list);
router.post('/admin/:entity', auth, controller.create);
router.put('/admin/:entity/:id', auth, controller.update);
router.delete('/admin/:entity/:id', auth, controller.remove);

module.exports = router;
