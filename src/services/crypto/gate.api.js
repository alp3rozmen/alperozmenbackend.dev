const axios = require('axios');

const api = axios.create({ baseURL: 'https://api.gateio.ws/api/v4', timeout: 15000 });

// Tüm spot ticker'ları tek istekte döner
async function fetchTickers() {
  const { data } = await api.get('/spot/tickers');
  return data;
}

// Gate.io mum formatı: [zaman(sn), quoteHacim, kapanış, yüksek, düşük, açılış, baseHacim, kapandıMı]
function parseCandle(c) {
  return {
    time: Number(c[0]) * 1000,
    quoteVolume: Number(c[1]),
    close: Number(c[2]),
    high: Number(c[3]),
    low: Number(c[4]),
    open: Number(c[5]),
    closed: c[7] === 'true',
  };
}

async function fetchCandles(pair, interval, limit) {
  const { data } = await api.get('/spot/candlesticks', {
    params: { currency_pair: pair, interval, limit },
  });
  return data.map(parseCandle);
}

const INTERVAL_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
// Gate tek istekte en fazla 1000 mum veriyor; aralık daha genişse "range too broad" hatası döner
const MAX_POINTS = 1000;

// Belirli bir zamandan bu yana olan mumlar (açık pozisyon kontrolü için); uzun aralık parçalara bölünür
async function fetchCandlesSince(pair, interval, fromMs) {
  const step = INTERVAL_SEC[interval] * (MAX_POINTS - 1);
  const now = Math.floor(Date.now() / 1000);
  const candles = [];
  for (let from = Math.floor(fromMs / 1000); from < now; from += step) {
    const { data } = await api.get('/spot/candlesticks', {
      params: { currency_pair: pair, interval, from, to: Math.min(from + step, now) },
    });
    for (const c of data) {
      const candle = parseCandle(c);
      // Parça sınırındaki mum iki kez gelebilir
      if (!candles.length || candle.time > candles[candles.length - 1].time) candles.push(candle);
    }
  }
  return candles;
}

module.exports = { fetchTickers, fetchCandles, fetchCandlesSince };
