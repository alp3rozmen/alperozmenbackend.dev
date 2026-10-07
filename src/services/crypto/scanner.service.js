const gate = require('./gate.api');
const binanceTr = require('./binancetr.api');
const telegram = require('../telegram');
const { evaluateBreakout, isMarketHealthy } = require('./strategy');
const CryptoSignal = require('../../models/CryptoSignal');
const { db } = require('../../config/db');

const DEFAULT_SETTINGS = {
  intervalMin: 5,          // tarama sıklığı (dakika)
  timeframe: '1h',         // sinyal mum aralığı
  // Ekim 2026 backtest'i (200 gün, 1h, komisyon dahil): 5M/2.5 → 1M/2.0 ile haftada ~9 → ~10 sinyal,
  // işlem başı +%0.57 → +%0.94, en büyük düşüş -%62 → -%41. Hacim/oran/kırılım filtrelerini gevşetmek
  // sinyali artırıyor ama getiriyi sıfıra yaklaştırıyor; kopma sınırını sıkmak her havuzda kaliteyi artırdı.
  minVolume24h: 1_000_000, // min. 24s USDT hacmi
  maxChange24h: 30,        // 24s'te bundan fazla pompalanmışları kovalama
  breakoutLookback: 20,
  minVolumeRatio: 2,
  rsiMin: 55,
  rsiMax: 78,
  maxExtensionAtr: 2,      // kırılım EMA20'den en fazla 2 ATR uzakta olmalı (geç kalınmış kırılımları ele)
  minAtrPct: 0.4,
  maxAtrPct: 6,
  slAtr: 2,                // stop = giriş - 2 ATR
  tpAtr: 4,                // hedef = giriş + 4 ATR (risk/ödül 1:2)
  maxHoldHours: 96,        // bu süre sonunda pozisyon piyasadan kapatılır
  cooldownHours: 24,       // aynı çifte tekrar sinyal için bekleme
  feePct: 0.2,             // alış + satış komisyonu toplamı
  binanceTrOnly: false,    // sadece Binance TR'de işlem gören coinler (backtest: haftada ~7.6 sinyal, işlem başı +%0.5)
  statusReports: false,    // her taramada Telegram'a sessiz durum raporu
};

const TIMEFRAME_MS = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000 };

// Mum aralığına göre tutma/bekleme süreleri (her biri ~96 ve ~24 mum)
const TIMEFRAME_PRESETS = {
  '15m': { maxHoldHours: 24, cooldownHours: 6 },
  '1h': { maxHoldHours: 96, cooldownHours: 24 },
  '4h': { maxHoldHours: 384, cooldownHours: 96 },
};

// DB'de sadece panelden seçilenler (mum aralığı ve iki seçenek) tutulur; geri kalan her şey koddaki varsayılanlardan gelir
// (eski kayıtlar tüm ayarları içeriyordu, onlar da böylece yeni varsayılanları alır)
function buildSettings(saved = {}) {
  const timeframe = TIMEFRAME_PRESETS[saved.timeframe] ? saved.timeframe : DEFAULT_SETTINGS.timeframe;
  return {
    ...DEFAULT_SETTINGS,
    ...TIMEFRAME_PRESETS[timeframe],
    timeframe,
    binanceTrOnly: !!saved.binanceTrOnly,
    statusReports: !!saved.statusReports,
  };
}

function savedPart(s) {
  return { timeframe: s.timeframe, binanceTrOnly: s.binanceTrOnly, statusReports: s.statusReports };
}
const LEVERAGED = /\d+[LS]_USDT$/;
const EXCLUDED = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDE', 'USDD', 'PYUSD', 'EUR', 'EURC', 'USD1', 'PAXG', 'XAUT', 'WBTC', 'STETH']);

let timer = null;
let monitorTimer = null;
let settings = buildSettings();
let inFlight = false;
let tickerCache = null; // { at, map }
let lastScan = null; // { at, candidates, signals, marketHealthy, durationMs }

function fmt(value) {
  if (value >= 1) return Number(value.toFixed(4)).toString();
  return Number(value.toPrecision(4)).toString();
}

function pairLink(pair) {
  if (settings.binanceTrOnly) {
    return `<a href="${binanceTr.tradeLink(pair.replace('_USDT', ''))}">Binance TR'de aç</a>`;
  }
  return `<a href="https://www.gate.io/trade/${pair}">Gate.io'da aç</a>`;
}

// Gate.io limitlerine takılmamak için sınırlı eşzamanlılıkla çalıştırır
async function mapLimit(items, limit, fn) {
  const results = [];
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// allowedBases: verilirse sadece bu coinler (Binance TR modu)
function pickCandidates(tickers, skipPairs, allowedBases) {
  return tickers.filter((t) => {
    if (!t.currency_pair.endsWith('_USDT')) return false;
    const base = t.currency_pair.replace('_USDT', '');
    if (LEVERAGED.test(t.currency_pair) || EXCLUDED.has(base)) return false;
    if (allowedBases && !allowedBases.has(base)) return false;
    if (skipPairs.has(t.currency_pair)) return false;
    const change = Number(t.change_percentage);
    return Number(t.quote_volume) >= settings.minVolume24h && change < settings.maxChange24h;
  });
}

// Sinyal sadece mum kapanışında oluşabilir; kapanıştan sonraki kısa pencere dışında aramaya gerek yok
function inSignalWindow() {
  const tf = TIMEFRAME_MS[settings.timeframe];
  const sinceClose = Date.now() % tf;
  return sinceClose <= settings.intervalMin * 2 * 60_000;
}

// closedAt: hedef/stop'a değen mumun zamanı (sunucu kapalıyken kapananlar da doğru zamanla yazılsın)
async function closeSignal(signal, status, exitPrice, extra, closedAt) {
  const pnl = (exitPrice / Number(signal.entry_price) - 1) * 100 - settings.feePct;
  await CryptoSignal.update(signal.id, { ...extra, status, exit_price: exitPrice, pnl_pct: pnl, closed_at: closedAt });

  const icon = { tp: '✅ HEDEF', sl: '🛑 STOP', expired: '⌛ SÜRE DOLDU' }[status];
  const hours = ((closedAt.getTime() - new Date(signal.opened_at).getTime()) / 3_600_000).toFixed(1);
  await telegram.sendMessage(
    `${icon}: <b>${signal.pair.replace('_USDT', '')}</b>\n` +
    `Giriş ${fmt(Number(signal.entry_price))} → Çıkış ${fmt(exitPrice)}\n` +
    `Sonuç: <b>${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%</b> (komisyon dahil) · ${hours} saat`
  ).catch((err) => console.error('Telegram hatası:', err.message));
  return { pair: signal.pair, status, pnl };
}

// Açık sanal pozisyonları son kontrolden bu yana oluşan 5dk mumlarla günceller.
// Aynı mumda hem stop hem hedef görüldüyse kötümser davranıp stop sayar.
// Süre dolumu mum zamanına göre: sunucu günlerce kapalı kalsa bile pozisyon tam süresi dolduğu andaki fiyattan kapanır.
// Dönüş: bu turda kapanan pozisyonlar
async function updateOpenSignals() {
  const open = await CryptoSignal.findOpen();

  const results = await mapLimit(open, 4, async (signal) => {
    const tp = Number(signal.tp_price);
    const sl = Number(signal.sl_price);
    const expiresAt = new Date(signal.opened_at).getTime() + settings.maxHoldHours * 3_600_000;
    let maxPrice = Number(signal.max_price);
    let minPrice = Number(signal.min_price);

    const candles = await gate.fetchCandlesSince(signal.pair, '5m', new Date(signal.checked_at).getTime());
    for (const c of candles) {
      if (c.time >= expiresAt) {
        return closeSignal(signal, 'expired', c.open, { max_price: maxPrice, min_price: minPrice }, new Date(c.time));
      }
      maxPrice = Math.max(maxPrice, c.high);
      minPrice = Math.min(minPrice, c.low);
      const extra = { max_price: maxPrice, min_price: minPrice };
      if (c.low <= sl) return closeSignal(signal, 'sl', sl, extra, new Date(c.time));
      if (c.high >= tp) return closeSignal(signal, 'tp', tp, extra, new Date(c.time));
    }

    const extra = { max_price: maxPrice, min_price: minPrice };

    // Son mum henüz kapanmamış olabilir; bir sonraki kontrol onun başından başlasın
    const lastCandle = candles[candles.length - 1];
    await CryptoSignal.update(signal.id, {
      ...extra,
      checked_at: lastCandle ? new Date(lastCandle.time) : signal.checked_at,
    });
    return null;
  });
  return results.filter(Boolean);
}

async function findNewSignals(tickers) {
  if (!inSignalWindow()) return { marketHealthy: null, candidates: 0, signals: 0, waiting: true };

  const btc = (await gate.fetchCandles('BTC_USDT', settings.timeframe, 100)).filter((c) => c.closed);
  const marketHealthy = isMarketHealthy(btc);
  if (!marketHealthy) return { marketHealthy, candidates: 0, signals: 0 };

  const cooldownStart = new Date(Date.now() - settings.cooldownHours * 3_600_000);
  const skipPairs = await CryptoSignal.recentPairs(cooldownStart);
  const allowedBases = settings.binanceTrOnly ? await binanceTr.fetchBaseAssets() : null;
  const candidates = pickCandidates(tickers, skipPairs, allowedBases);

  const results = await mapLimit(candidates, 5, async (t) => {
    const candles = (await gate.fetchCandles(t.currency_pair, settings.timeframe, 120)).filter((c) => c.closed);
    // Kırılım mumu yeni kapanmış olmalı; sunucu kapalıyken kaçan eski kırılımlara geç girme
    const lastClose = candles[candles.length - 1].time + TIMEFRAME_MS[settings.timeframe];
    if (Date.now() - lastClose > settings.intervalMin * 2 * 60_000) return null;
    const hit = evaluateBreakout(candles, settings);
    return hit ? { ticker: t, ...hit } : null;
  });

  const opened = [];
  for (const r of results) {
    if (!r) continue;
    const entry = Number(r.ticker.last);
    const sl = entry - settings.slAtr * r.atr;
    const tp = entry + settings.tpAtr * r.atr;
    const now = new Date();

    await CryptoSignal.create({
      pair: r.ticker.currency_pair,
      entry_price: entry,
      tp_price: tp,
      sl_price: sl,
      atr: r.atr,
      rsi: r.rsi,
      volume_ratio: r.volumeRatio,
      change_24h: Number(r.ticker.change_percentage),
      status: 'open',
      max_price: entry,
      min_price: entry,
      opened_at: now,
      checked_at: now,
    });
    const coin = r.ticker.currency_pair.replace('_USDT', '');
    opened.push(coin);
    await telegram.sendMessage(
      `🟢 <b>AL: ${coin}/USDT</b>\n` +
      `Giriş: ${fmt(entry)}\n` +
      `🎯 Hedef: ${fmt(tp)} (+${((tp / entry - 1) * 100).toFixed(2)}%)\n` +
      `🛑 Stop: ${fmt(sl)} (${((sl / entry - 1) * 100).toFixed(2)}%)\n` +
      `Hacim ${r.volumeRatio.toFixed(1)}x · RSI ${r.rsi.toFixed(0)} · 24s ${Number(r.ticker.change_percentage).toFixed(1)}%\n` +
      pairLink(r.ticker.currency_pair)
    ).catch((err) => console.error('Telegram hatası:', err.message));
  }

  return { marketHealthy, candidates: candidates.length, signals: opened.length, opened };
}

// Uygulama ve cron script'i aynı anda çalışmasın (aynı sinyal/kapanış iki kez yazılmasın)
async function withLock(fn) {
  if (inFlight) return { skipped: true };
  inFlight = true;
  let conn;
  try {
    conn = await db.getConnection();
    const [[lock]] = await conn.query("SELECT GET_LOCK('crypto_tick', 0) AS ok");
    if (!lock.ok) return { skipped: true };
    try {
      return await fn();
    } finally {
      await conn.query("SELECT RELEASE_LOCK('crypto_tick')").catch(() => {});
    }
  } finally {
    conn?.release();
    inFlight = false;
  }
}

function nextSignalWindow() {
  const tf = TIMEFRAME_MS[settings.timeframe];
  return new Date(Math.floor(Date.now() / tf) * tf + tf);
}

function clock(date) {
  return date.toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
}

// "Botun aktifliğini bildir" açıksa her taramadan sonra sessiz bir özet gönderir
async function sendStatusReport(result, closed, tickers) {
  const prices = new Map(tickers.map((t) => [t.currency_pair, Number(t.last)]));
  const open = await CryptoSignal.findOpen();
  const pnls = open
    .map((s) => prices.get(s.pair) && (prices.get(s.pair) / Number(s.entry_price) - 1) * 100 - settings.feePct)
    .filter((v) => typeof v === 'number');

  let scanLine;
  if (result.waiting) scanLine = `⏳ Mum kapanışı bekleniyor, sonraki sinyal taraması ${clock(nextSignalWindow())}`;
  else if (result.marketHealthy === false) scanLine = '⚠️ BTC zayıf, yeni sinyal aranmadı';
  else if (result.signals) scanLine = `🟢 ${result.candidates} coin tarandı, ${result.signals} sinyal: ${result.opened.join(', ')}`;
  else scanLine = `🔍 ${result.candidates} coin tarandı, kriterlere uyan yok`;

  const lines = [
    `🤖 <b>Bot aktif</b> · ${clock(new Date())}`,
    `${settings.timeframe} mum · ${settings.binanceTrOnly ? 'Binance TR coinleri' : 'Tüm Gate.io coinleri'}`,
    scanLine,
    `📂 Açık pozisyon: ${open.length}` +
      (pnls.length ? ` (ort. ${(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)}%)` : ''),
  ];
  if (closed.length) {
    lines.push(`📕 Bu turda kapanan: ${closed.map((c) => `${c.pair.replace('_USDT', '')} ${c.pnl > 0 ? '+' : ''}${c.pnl.toFixed(2)}%`).join(', ')}`);
  }
  lines.push(`⏱ ${(result.durationMs / 1000).toFixed(1)} sn`);

  await telegram.sendMessage(lines.join('\n'), { silent: true })
    .catch((err) => console.error('Telegram hatası:', err.message));
}

// Tek tarama turu. Hem iç zamanlayıcı hem de dışarıdan (cron) çağrılabilir.
function tick() {
  return withLock(async () => {
    const started = Date.now();
    try {
      const tickers = await gate.fetchTickers();
      const closed = await updateOpenSignals();
      const result = await findNewSignals(tickers);

      lastScan = { at: new Date(), durationMs: Date.now() - started, ...result };
      await CryptoSignal.saveState({ last_scan_at: lastScan.at, last_error: null });
      if (settings.statusReports) await sendStatusReport(lastScan, closed, tickers);
      return lastScan;
    } catch (err) {
      console.error('Kripto tarama hatası:', err.message);
      await CryptoSignal.saveState({ last_error: String(err.message).slice(0, 500) }).catch(() => {});
      if (settings.statusReports) {
        await telegram.sendMessage(`⚠️ <b>Tarama hatası</b> · ${clock(new Date())}\n${telegram.escapeHtml(err.message)}`, { silent: true })
          .catch(() => {});
      }
      throw err;
    }
  });
}

// Tarayıcı durdurulmuş olsa da açık pozisyonlar hedef/stop/süre için takip edilmeye devam eder
function trackPositions() {
  return withLock(() => updateOpenSignals());
}

function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    if (!timer) trackPositions().catch((err) => console.error('Pozisyon takibi hatası:', err.message));
  }, DEFAULT_SETTINGS.intervalMin * 60_000);
}

// Cron script'i için: bot panelden açık bırakıldıysa kayıtlı ayarlarla tek tur tarar
async function tickIfRunning() {
  const state = await CryptoSignal.getState();
  settings = buildSettings(state?.settings);
  if (!state?.running) return trackPositions();
  return tick();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick().catch(() => {});
    if (timer) schedule();
  }, settings.intervalMin * 60_000);
}

// Seçenekler (Binance TR, durum raporu) panelden ayrıca kaydedildiği için başlatırken korunur
async function start({ timeframe, ...options } = {}) {
  const state = await CryptoSignal.getState();
  settings = buildSettings({ ...state?.settings, ...options, timeframe });
  await CryptoSignal.saveState({ running: 1, settings: savedPart(settings) });
  schedule();
  tick().catch(() => {});
  await telegram.sendMessage(
    `🤖 Kripto tarayıcı başladı. ${settings.intervalMin} dk'da bir, ${settings.timeframe} mumlarla ` +
    `${settings.binanceTrOnly ? 'Binance TR coinleri' : 'tüm Gate.io coinleri'} taranıyor.` +
    (settings.statusReports ? `\nDurum raporu açık: her taramada sessiz özet gelecek.` : '')
  ).catch((err) => console.error('Telegram hatası:', err.message));
  return settings;
}

// Panelden checkbox değişince; bot çalışırken de anında geçerli olur
async function setOptions(options) {
  const state = await CryptoSignal.getState();
  settings = buildSettings({ ...state?.settings, ...options });
  await CryptoSignal.saveState({ settings: savedPart(settings) });
  return settings;
}

async function stop() {
  clearTimeout(timer);
  timer = null;
  await CryptoSignal.saveState({ running: 0 });
}

// Sunucu yeniden başladığında, bot açık bırakıldıysa kaldığı yerden devam et;
// kapalıyken biriken pozisyon kontrollerini de hemen yap
async function resumeIfRunning() {
  startMonitor();
  try {
    const state = await CryptoSignal.getState();
    settings = buildSettings(state?.settings);
    if (state?.running) {
      schedule();
      console.log('Kripto tarayıcı devam ettiriliyor');
    }
    await trackPositions();
  } catch (err) {
    console.error('Kripto tarayıcı durumu okunamadı:', err.message);
  }
}

// Panel için anlık fiyatlar; tüm ticker'lar tek istek, 15 sn önbellek
async function livePrices() {
  if (!tickerCache || Date.now() - tickerCache.at > 15_000) {
    const tickers = await gate.fetchTickers();
    tickerCache = { at: Date.now(), map: new Map(tickers.map((t) => [t.currency_pair, Number(t.last)])) };
  }
  return tickerCache.map;
}

// Açık sinyallere son fiyat ve anlık kâr/zarar (komisyon dahil) ekler
async function withLivePrices(signals) {
  if (!signals.some((s) => s.status === 'open')) return signals;
  const prices = await livePrices().catch(() => new Map());
  return signals.map((s) => {
    const last = s.status === 'open' ? prices.get(s.pair) : undefined;
    if (!last) return s;
    return { ...s, last_price: last, current_pnl: (last / Number(s.entry_price) - 1) * 100 - settings.feePct };
  });
}

async function listSignals(query) {
  return withLivePrices(await CryptoSignal.list(query));
}

async function status() {
  const state = await CryptoSignal.getState();
  const open = await withLivePrices(await CryptoSignal.findOpen());
  const priced = open.filter((s) => s.current_pnl !== undefined);
  return {
    // Cron script'i ayrı süreçte çalışabildiği için durum DB'den okunur
    running: !!state?.running,
    settings: buildSettings(state?.settings),
    timeframes: Object.keys(TIMEFRAME_PRESETS),
    lastScan,
    lastScanAt: state?.last_scan_at || null,
    lastError: state?.last_error || null,
    stats: {
      ...(await CryptoSignal.stats()),
      openAvgPnl: priced.length ? priced.reduce((sum, s) => sum + s.current_pnl, 0) / priced.length : null,
    },
  };
}

module.exports = { start, stop, setOptions, tick, tickIfRunning, status, listSignals, resumeIfRunning, DEFAULT_SETTINGS, TIMEFRAME_PRESETS };
