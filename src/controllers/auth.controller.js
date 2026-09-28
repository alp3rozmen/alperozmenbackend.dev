const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.checkIsLoggedIn = (req, res) => {
  res.status(200).json({ data: { isLoggedIn: true } });
};

// Yeni kullanıcıyı sadece giriş yapmış bir kullanıcı ekleyebilir (route'ta auth var)
exports.register = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ message: 'Kullanıcı adı ve en az 8 karakterli şifre gerekli.' });
    }
    const existingUser = await User.findByUsername(username);
    if (existingUser) return res.status(400).json({ message: 'Kullanıcı zaten var.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });
    res.status(201).json({ message: 'Kayıt başarılı.' });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
};

exports.listUsers = async (req, res) => {
  try {
    res.json(await User.findAll());
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
};

exports.removeUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.userId) return res.status(400).json({ message: 'Kendi hesabınızı silemezsiniz.' });
    const removed = await User.remove(id);
    if (!removed) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Kullanıcı silindi.' });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
    const user = await User.findByUsername(username);
    const isMatch = user && await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Kullanıcı adı veya şifre hatalı.' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
};
