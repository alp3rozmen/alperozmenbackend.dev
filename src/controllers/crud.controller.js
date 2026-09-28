// Blog gibi basit tablolar için ortak controller üreticisi.
// `fields`: req.body'den alınacak alanlar, `label`: mesajlardaki isim (örn. 'Blog').
module.exports = (Model, fields, label) => {
  const pickBody = (body) => Object.fromEntries(fields.map((f) => [f, body[f]]));

  return {
    list: async (req, res) => {
      try {
        res.json(await Model.findAll());
      } catch (err) {
        res.status(500).json({ message: 'Sunucu hatası.' });
      }
    },

    getById: async (req, res) => {
      try {
        const item = await Model.findById(req.params.id);
        if (!item) return res.status(404).json({ message: `${label} bulunamadı.` });
        res.json(item);
      } catch (err) {
        res.status(500).json({ message: 'Sunucu hatası.' });
      }
    },

    create: async (req, res) => {
      try {
        res.status(201).json(await Model.create(pickBody(req.body)));
      } catch (err) {
        res.status(500).json({ message: 'Sunucu hatası.' });
      }
    },

    update: async (req, res) => {
      try {
        const item = await Model.update(req.params.id, pickBody(req.body));
        if (!item) return res.status(404).json({ message: `${label} bulunamadı.` });
        res.json(item);
      } catch (err) {
        res.status(500).json({ message: 'Sunucu hatası.' });
      }
    },

    remove: async (req, res) => {
      try {
        const deleted = await Model.remove(req.params.id);
        if (!deleted) return res.status(404).json({ message: `${label} bulunamadı.` });
        res.json({ message: `${label} silindi.` });
      } catch (err) {
        res.status(500).json({ message: 'Sunucu hatası.' });
      }
    }
  };
};
