const router = require('express').Router();

// Veritabanı hazır olunca ilgili satırların yorumunu kaldır.
router.use('/auth', require('./auth.routes'));
router.use('/blogs', require('./blog.routes'));
router.use('/instagram', require('./instagram.routes'));
router.use('/crypto', require('./crypto.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/tiktok', require('./tiktok.routes'));
// router.use('/mhrs-autorandevu', require('./mhrs.routes'));

module.exports = router;
