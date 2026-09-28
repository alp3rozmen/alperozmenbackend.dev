// Basit bellek içi IP sınırlayıcı: brute force denemelerini yavaşlatır.
// Tek süreçte çalıştığımız için harici bir depoya gerek yok.
module.exports = function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return function (req, res, next) {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ message: message || 'Çok fazla deneme. Lütfen daha sonra tekrar deneyin.' });
    }
    next();
  };
};
