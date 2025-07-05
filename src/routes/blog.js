const express = require('express');
const Blog = require('../models/Blog');
const auth = require('../middleware/auth');

const router = express.Router();

// Tüm blogları listele
router.get('/', async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json(blogs);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Blog ekle (JWT gerekli)
router.post('/add', auth, async (req, res) => {
  try {
    const { title, content, author } = req.body;
    const blog = new Blog({ title, content, author });
    await blog.save();
    res.status(201).json(blog);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog bulunamadı.' });
    res.json(blog);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Blog güncelle (JWT gerekli)
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, content, author } = req.body;
    const blog = await Blog.findByIdAndUpdate(
      req.params.id,
      { title, content, author },
      { new: true }
    );
    if (!blog) return res.status(404).json({ message: 'Blog bulunamadı.' });
    res.json(blog);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Blog sil (JWT gerekli)
router.delete('/:id', auth, async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog bulunamadı.' });
    res.json({ message: 'Blog silindi.' });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

module.exports = router;
