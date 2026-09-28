const Setting = require('../models/Setting');

exports.list = async (req, res) => {
  try {
    res.json(await Setting.listForPanel());
  } catch (err) {
    res.status(500).json({ message: 'Ayarlar alınamadı.' });
  }
};

exports.update = async (req, res) => {
  try {
    await Setting.setMany(req.body || {});
    res.json({ message: 'Ayarlar kaydedildi.', settings: await Setting.listForPanel() });
  } catch (err) {
    res.status(500).json({ message: 'Ayarlar kaydedilemedi.' });
  }
};
