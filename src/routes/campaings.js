const express = require('express');
const Campaign = require('../models/Campaings');
const auth = require('../middleware/auth');

const router = express.Router();

// Tüm kampanyaları listele
router.get('/', async (req, res) => {
  try {
    const campaigns = await Campaign.find().sort({ createdAt: -1 });
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Kampanya ekle (JWT gerekli)
router.post('/add', auth, async (req, res) => {
  try {
    const { companyName, startDate, endDate, acPrice, acDiscount, dc30Price, dc30Discount, dc60Price, dc60Discount, dc120Price, dc120Discount, dc180Price, dc180Discount, dcOver180Price, dcOver180Discount } = req.body;
    const campaign = new Campaign({ companyName, startDate, endDate, acPrice, acDiscount, dc30Price, dc30Discount, dc60Price, dc60Discount, dc120Price, dc120Discount, dc180Price, dc180Discount, dcOver180Price, dcOver180Discount });
    await campaign.save();
    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ message: 'Kampanya bulunamadı.' });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Kampanya güncelle (JWT gerekli)
router.put('/:id', auth, async (req, res) => {
  try {
    const { companyName, startDate, endDate, acPrice, acDiscount, dc30Price, dc30Discount, dc60Price, dc60Discount, dc120Price, dc120Discount, dc180Price, dc180Discount, dcOver180Price, dcOver180Discount } = req.body;
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { companyName, startDate, endDate, acPrice, acDiscount, dc30Price, dc30Discount, dc60Price, dc60Discount, dc120Price, dc120Discount, dc180Price, dc180Discount, dcOver180Price, dcOver180Discount },
      { new: true }
    );
    if (!campaign) return res.status(404).json({ message: 'Kampanya bulunamadı.' });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

// Kampanya sil (JWT gerekli)
router.delete('/:id', auth, async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndDelete(req.params.id);
    if (!campaign) return res.status(404).json({ message: 'Kampanya bulunamadı.' });
    res.json({ message: 'Kampanya silindi.' });
  } catch (err) {
    res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

module.exports = router;
