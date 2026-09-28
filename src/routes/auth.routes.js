const router = require('express').Router();
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const authController = require('../controllers/auth.controller');

// 15 dakikada IP başına en fazla 10 deneme
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.post('/checkIsLoggedIn', auth, authController.checkIsLoggedIn);
router.post('/register', auth, authController.register);
router.get('/users', auth, authController.listUsers);
router.delete('/users/:id', auth, authController.removeUser);
router.post('/login', loginLimiter, authController.login);

module.exports = router;
