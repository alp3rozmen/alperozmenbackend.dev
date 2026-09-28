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

// Belirli bir zamandan bu yana olan mumlar (açık pozisyon kontrolü için)
async function fetchCandlesSince(pair, interval, fromMs) {
  const { data } = await api.get('/spot/candlesticks', {
    params: {
      currency_pair: pair,
      interval,
      from: Math.floor(fromMs / 1000),
      to: Math.floor(Date.now() / 1000),
    },
  });
  return data.map(parseCandle);
}

module.exports = { fetchTickers, fetchCandles, fetchCandlesSince };
