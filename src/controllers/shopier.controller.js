const api = require('../services/shopier/shopier.api');
const prices = require('../services/shopier/price.service');
const ShopierBatch = require('../models/ShopierBatch');

// Servisler beklenen hatalara `status` koyar; onun dışındakiler sunucu hatasıdır
const fail = (res, err) => {
  if (!err.status) console.error('shopier:', err);
  // Shopier oturum hatası 401 olarak dönmez: panel 401'i kendi oturumunun düşmesi sayar
  // Shopier kaynaklı hatalar (502) 400 olarak döner: hosting 5xx cevapların gövdesini kendi hata sayfasıyla değiştirip mesajı yutuyor
  const code = err.status === 401 ? 409 : err.status >= 500 ? 400 : err.status;
  res.status(code || 500).json({ message: err.status ? err.message : 'Sunucu hatası.' });
};

module.exports = {
  status: async (req, res) => {
    try {
      res.json(await api.status());
    } catch (err) {
      fail(res, err);
    }
  },

  // Panel, Shopier giriş sayfasına bu adresle yönlendirir; state'i panel üretir ve dönüşte kendisi doğrular
  oauthUrl: async (req, res) => {
    try {
      const redirectUri = String(req.query.redirectUri || '');
      const state = String(req.query.state || '');
      if (!/^https?:\/\/[^\s]+$/.test(redirectUri) || !/^[A-Za-z0-9]{8,64}$/.test(state)) {
        return res.status(400).json({ message: 'Geçersiz yönlendirme adresi ya da state.' });
      }
      res.json({ url: await api.authorizeUrl(redirectUri, state) });
    } catch (err) {
      fail(res, err);
    }
  },

  oauthExchange: async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) return res.status(400).json({ message: 'Yetki kodu eksik.' });
      await api.exchangeCode(code);
      res.json({ message: 'Shopier hesabı bağlandı.', status: await api.status() });
    } catch (err) {
      fail(res, err);
    }
  },

  disconnect: async (req, res) => {
    try {
      await api.disconnect();
      res.json({ message: 'Shopier bağlantısı kaldırıldı.', status: await api.status() });
    } catch (err) {
      fail(res, err);
    }
  },

  products: async (req, res) => {
    try {
      res.json(await prices.listProducts());
    } catch (err) {
      fail(res, err);
    }
  },

  createBatch: async (req, res) => {
    try {
      const id = await prices.start(req.body?.label, req.body?.items);
      res.status(202).json({ id });
    } catch (err) {
      fail(res, err);
    }
  },

  listBatches: async (req, res) => {
    try {
      res.json(await ShopierBatch.list());
    } catch (err) {
      fail(res, err);
    }
  },

  getBatch: async (req, res) => {
    try {
      const batch = await ShopierBatch.get(Number(req.params.id));
      if (!batch) return res.status(404).json({ message: 'İşlem bulunamadı.' });
      res.json(batch);
    } catch (err) {
      fail(res, err);
    }
  },

  revertBatch: async (req, res) => {
    try {
      const id = await prices.revert(Number(req.params.id));
      res.status(202).json({ id });
    } catch (err) {
      fail(res, err);
    }
  },
};
