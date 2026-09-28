const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.checkIsLoggedIn = (req, res) => {
  res.status(200).json({ data: { isLoggedIn: true } });
};

exports.register = async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findByUsername(username);
    if (existingUser) return res.status(400).json({ message: 'Kullanıcı zaten var.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });
    res.status(201).json({ message: 'Kayıt başarılı.' });
  } catch (err) {
    res.status(500).json({ message: err.message + 'Sunucu hatası.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findByUsername(username);
    if (!user) return res.status(400).json({ message: 'Kullanıcı bulunamadı.' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Şifre hatalı.' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
};
