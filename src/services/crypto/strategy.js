const { sma, ema, rsi, atr } = require('./indicators');

// Hacim onaylı trend kırılımı (sadece long).
// candles: yalnızca KAPANMIŞ mumlar, eskiden yeniye sıralı.
// Sinyal yoksa null, varsa göstergeleri döner.
function evaluateBreakout(candles, s) {
  if (candles.length < 60) return null;

  const last = candles[candles.length - 1];
  const prev = candles.slice(0, -1);
  const closes = candles.map((c) => c.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiValue = rsi(closes, 14);
  const atrValue = atr(candles, 14);
  const avgVolume = sma(prev.map((c) => c.quoteVolume), 20);
  const highestHigh = Math.max(...prev.slice(-s.breakoutLookback).map((c) => c.high));

  const volumeRatio = avgVolume > 0 ? last.quoteVolume / avgVolume : 0;
  const range = last.high - last.low;
  const closeStrength = range > 0 ? (last.close - last.low) / range : 0;
  const atrPct = (atrValue / last.close) * 100;
  const extension = (last.close - ema20) / atrValue;

  const passed =
    last.close > highestHigh &&            // kapanışla kırılım
    ema20 > ema50 && last.close > ema20 && // yükseliş trendi
    last.close > last.open &&
    volumeRatio >= s.minVolumeRatio &&     // hacim onayı
    rsiValue >= s.rsiMin && rsiValue <= s.rsiMax &&
    closeStrength >= 0.6 &&                // fitilli değil, tepeye yakın kapanış
    extension <= s.maxExtensionAtr &&      // ortalamadan fazla kopmamış
    atrPct >= s.minAtrPct && atrPct <= s.maxAtrPct; // komisyonu karşılayacak ama aşırı olmayan oynaklık

  if (!passed) return null;

  return { atr: atrValue, rsi: rsiValue, volumeRatio };
}

// BTC sert düşüşteyken altcoin kırılımları genelde tutmaz
function isMarketHealthy(btcCandles) {
  const closes = btcCandles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const oneHourAgo = closes[closes.length - 5];
  return last > ema(closes, 50) || (last / oneHourAgo - 1) * 100 > -0.5;
}

module.exports = { evaluateBreakout, isMarketHealthy };
