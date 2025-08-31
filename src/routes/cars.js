const express = require('express');
const Cars = require('../models/Cars');
const auth = require('../middleware/auth');

const router = express.Router();

// Tüm arabaları listele
router.get('/', async (req, res) => {
  try {
    const cars = await Cars.find().sort({ createdAt: -1 });
    res.json(cars);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Araba ekle (JWT gerekli)
router.post('/add', auth, async (req, res) => {
  try {
    const { brand, battery } = req.body;
    const car = new Cars({ brand, battery });
    await car.save();
    res.status(201).json(car);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const car = await Cars.findById(req.params.id);
    if (!car) return res.status(404).json({ message: 'Araba bulunamadı.' });
    res.json(car);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Araba güncelle (JWT gerekli)
router.put('/:id', auth, async (req, res) => {
  try {
    const { brand, battery } = req.body;
    const car = await Cars.findByIdAndUpdate(
      req.params.id,
      { brand, battery },
      { new: true }
    );
    if (!car) return res.status(404).json({ message: 'Araba bulunamadı.' });
    res.json(car);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Araba sil (JWT gerekli)
router.delete('/:id', auth, async (req, res) => {
  try {
    const car = await Cars.findByIdAndDelete(req.params.id);
    if (!car) return res.status(404).json({ message: 'Araba bulunamadı.' });
    res.json({ message: 'Araba silindi.' });
  } catch (err) {   
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

module.exports = router;
