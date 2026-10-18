const router = require('express').Router();

// Veritabanı hazır olunca ilgili satırların yorumunu kaldır.
// Hostingin bot koruması /admin altındaki istekleri, tarayıcı "Checking your browser" doğrulamasını geçene kadar engelliyor.
// Arka plandaki API istekleri bu doğrulamayı çözemez; panel bu adrese tam sayfa yönlendirir, doğrulama geçince istek
// buraya ulaşır ve kullanıcı paneldeki sayfasına geri gönderilir. Sadece aynı sitedeki yollara yönlendirir (açık yönlendirme yok).
router.get('/pass', (req, res) => {
  const to = String(req.query.to || '');
  const safe = /^\/(?![/\\])[^\s]{0,300}$/.test(to) ? to : '/Dashboard';
  res.redirect(302, safe);
});

router.use('/auth', require('./auth.routes'));
router.use('/blogs', require('./blog.routes'));
router.use('/instagram', require('./instagram.routes'));
router.use('/crypto', require('./crypto.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/tiktok', require('./tiktok.routes'));
router.use('/channels', require('./channel.routes'));
// router.use('/mhrs-autorandevu', require('./mhrs.routes'));

module.exports = router;
