// Her fonksiyon, girdi dizisinin son elemanına ait değeri döner.

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

// Wilder RSI
function rsi(closes, period = 14) {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Wilder ATR
function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  let result = sma(trs.slice(0, period), period);
  for (let i = period; i < trs.length; i++) {
    result = (result * (period - 1) + trs[i]) / period;
  }
  return result;
}

module.exports = { sma, ema, rsi, atr };
