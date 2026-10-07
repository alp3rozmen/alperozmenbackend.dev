const axios = require('axios');

// Binance TR'de işlem gören coinler (hepsi TRY paritesi). Liste nadiren değiştiği için 6 saat önbellekte tutulur.
const CACHE_MS = 6 * 3_600_000;
let cache = null; // { at, bases }

async function fetchBaseAssets() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.bases;
  try {
    const { data } = await axios.get('https://www.binance.tr/open/v1/common/symbols', { timeout: 15000 });
    if (data.code !== 0 || !Array.isArray(data.data?.list)) throw new Error(data.msg || 'Beklenmeyen cevap');
    const bases = new Set(data.data.list.filter((s) => s.spotTradingEnable).map((s) => s.baseAsset));
    cache = { at: Date.now(), bases };
    return bases;
  } catch (err) {
    // Liste alınamazsa eskisiyle devam et; hiç yoksa tüm coinlere dönmek yerine hata ver
    if (cache) return cache.bases;
    throw new Error('Binance TR coin listesi alınamadı: ' + err.message);
  }
}

function tradeLink(coin) {
  return `https://www.binance.tr/tr/trade/${coin}_TRY`;
}

module.exports = { fetchBaseAssets, tradeLink };
