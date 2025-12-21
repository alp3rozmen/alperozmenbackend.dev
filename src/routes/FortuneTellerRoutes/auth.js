const { fortuneDb } = require('../../dbConnection');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../models/FortuneTeller/User')(fortuneDb);
const auth = require('../../middleware/auth');

const router = express.Router();

router.post('/checkIsLoggedIn', auth, (req, res) => {
  res.status(200).json({ data: { isLoggedIn: true } });
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password || !email) return res.status(400).json({ status: 'error', message: 'Tüm alanları doldurun.' });
    const existingUser = await User.findOne({ username });
    const existingEmail = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ status: 'error', message: 'Kullanıcı zaten var.' });
    if (existingEmail) return res.status(400).json({ status: 'error', message: 'Email zaten var.' });
    //add all validations
    if (password.length < 8) return res.status(400).json({ status: 'error', message: 'Şifre en az 8 karakter olmalı.' });
    if (!email.includes('@')) return res.status(400).json({ status: 'error', message: 'Email geçersiz.' });
    if (username.length < 3) return res.status(400).json({ status: 'error', message: 'Kullanıcı adı en az 3 karakter olmalı.' });
    if (username.length > 10) return res.status(400).json({ status: 'error', message: 'Kullanıcı adı en fazla 10 karakter olmalı.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, email, credits: 0, createdAt: new Date(), updatedAt: new Date() });
    await user.save();
    res.status(201).json({ status: 'success', message: 'Kayıt başarılı.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message + 'Sunucu hatası.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ status: 'error', message: 'Kullanıcı bulunamadı.' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ status: 'error', message: 'Şifre hatalı.' });
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ status: 'success', token, data: { username: user.username, email: user.email, credits: user.credits } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Sunucu hatası.' });
  }
});

module.exports = router;
