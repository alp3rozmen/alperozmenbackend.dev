const Gavelon = require('../models/Gavelon');

const serverError = (res, err) => {
  console.error('gavelon:', err);
  res.status(500).json({ message: 'Sunucu hatası.' });
};

// Her başarılı yazmadan sonra otomatik yayın. Veri geçersizse kayıt yine kaydedilir (önce karakteri,
// sonra bağını ekleyebilmek için); yayın hataları cevapta "publish" altında döner.
async function publishQuietly() {
  try {
    return await Gavelon.publish();
  } catch (err) {
    console.error('gavelon publish:', err);
    return { published: false, errors: [`Yayın hatası: ${err.message}`] };
  }
}

const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

module.exports = {
  // Herkese açık: yerel geliştirmede ve data.json yayını kapalıyken doğrudan okunabilir.
  publicData: async (req, res) => {
    try {
      const { data, errors } = await Gavelon.validate();
      if (errors.length) return res.status(503).json({ message: 'İçerik geçersiz.', errors });
      res.json(data);
    } catch (err) {
      serverError(res, err);
    }
  },

  list: async (req, res) => {
    try {
      res.json(await Gavelon.list(req.params.entity));
    } catch (err) {
      serverError(res, err);
    }
  },

  create: async (req, res) => {
    try {
      const result = await Gavelon.create(req.params.entity, req.body || {});
      if (result.error) return res.status(400).json({ message: result.error });
      res.status(201).json({ item: result.item, publish: await publishQuietly() });
    } catch (err) {
      serverError(res, err);
    }
  },

  update: async (req, res) => {
    try {
      const result = await Gavelon.update(req.params.entity, req.params.id, req.body || {});
      if (result.notFound) return res.status(404).json({ message: 'Kayıt bulunamadı.' });
      if (result.error) return res.status(400).json({ message: result.error });
      res.json({ item: result.item, publish: await publishQuietly() });
    } catch (err) {
      serverError(res, err);
    }
  },

  remove: async (req, res) => {
    try {
      if (!(await Gavelon.remove(req.params.entity, req.params.id))) return res.status(404).json({ message: 'Kayıt bulunamadı.' });
      res.json({ message: 'Silindi.', publish: await publishQuietly() });
    } catch (err) {
      serverError(res, err);
    }
  },

  getConfig: async (req, res) => {
    try {
      res.json(await Gavelon.getConfig());
    } catch (err) {
      serverError(res, err);
    }
  },

  saveConfig: async (req, res) => {
    try {
      const result = await Gavelon.saveConfig(req.body);
      if (result.error) return res.status(400).json({ message: result.error });
      res.json({ config: result.config, publish: await publishQuietly() });
    } catch (err) {
      serverError(res, err);
    }
  },

  validate: async (req, res) => {
    try {
      const { data, errors } = await Gavelon.validate();
      res.json({ version: data.version, errors, counts: { characters: data.characters.length, bonds: data.bonds.length, tables: data.tables.length, scenarios: data.scenarios.length } });
    } catch (err) {
      serverError(res, err);
    }
  },

  publish: async (req, res) => {
    try {
      res.json(await Gavelon.publish());
    } catch (err) {
      serverError(res, err);
    }
  },

  upload: (req, res) => {
    const ext = req.file && IMAGE_TYPES[req.file.mimetype];
    if (!ext) return res.status(400).json({ message: 'Yalnızca PNG, JPG veya WEBP yüklenebilir.' });
    // Üretimde GAVELON_PUBLIC_URL statik klasörün adresidir; yerelde API'nin kendi /img yolu kullanılır.
    const base = process.env.GAVELON_PUBLIC_URL || `${req.protocol}://${req.get('host')}${process.env.BASE_PATH || ''}/api/gavelon`;
    try {
      res.status(201).json({ url: Gavelon.saveImage(req.file.buffer, ext, base) });
    } catch (err) {
      serverError(res, err);
    }
  },
};
