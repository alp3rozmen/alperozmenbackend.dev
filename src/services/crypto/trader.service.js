const gp = require('./gate.private');
const gate = require('./gate.api');
const news = require('./news');
const telegram = require('../telegram');
const CryptoTrade = require('../../models/CryptoTrade');
const CryptoSignal = require('../../models/CryptoSignal');
const CryptoOpportunity = require('../../models/CryptoOpportunity');
const Setting = require('../../models/Setting');
const { db } = require('../../config/db');

// Yarı otomatik gerçek işlem (Gate.io spot).
// - Bot ALIM YAPMAZ, ÖNERİR: sinyal + haber kontrolü + pozisyon büyüklüğü Telegram'a "Al / Geç" butonlarıyla gelir.
//   Emir sadece kullanıcı onaylayınca (Telegram ya da panel) verilir.
// - Onaylanan alımdan sonra stop ve hedef emirleri BORSAYA konur (tetikli emir): sunucu çökse de stop çalışır.
// - Bot kendiliğinden satış yapmaz; stop/hedef borsada tetiklenir. Süre dolunca ya da stop konamazsa "Sat" butonuyla sorar.
// - Risk: işlem başı sermayenin sabit küçük yüzdesi; en fazla N pozisyon; günlük zarar limiti dolunca öneri yok.
// - Bot sadece kendi aldığı miktarı satar; hesaptaki diğer coinlere dokunmaz.

const PROFILES = {
  conservative: { label: 'Muhafazakâr', riskPct: 0.5, maxPositions: 2, dailyLossPct: 2 },
  balanced: { label: 'Dengeli', riskPct: 1, maxPositions: 3, dailyLossPct: 3 },
  aggressive: { label: 'Agresif', riskPct: 2, maxPositions: 5, dailyLossPct: 5 },
};
const NEWS_MODES = ['off', 'veto', 'veto+opportunities'];
const DEFAULT_TRADING = { enabled: false, capitalUsdt: 0, riskProfile: 'balanced', newsMode: 'veto+opportunities' };

const MONITOR_MS = 60_000;
const PROPOSAL_TTL_MS = 30 * 60_000;  // 1 saatlik mumda kırılımdan sonraki 30 dk; sonra fiyat kaçmış olur
const MAX_CHASE_PCT = 1.5;            // onay anında fiyat sinyalden bu kadar yukarı kaçtıysa alma
const MIN_ORDER_USDT = 5;             // Gate'in alt sınırının üstü; çok küçük pozisyona stop konamaz
const MAX_SPREAD_PCT = 0.4;           // alış-satış farkı bundan büyükse önerme (kayma riski)
const OPPORTUNITY_SIZE_FACTOR = 0.5;  // haber fırsatı coinler daha az likit: yarım pozisyon
const OPPORTUNITY_MIN_VOLUME = 300_000;
const OPPORTUNITY_TTL_MS = 24 * 3_600_000;
const OPPORTUNITY_EVERY_MS = 12 * 3_600_000;
const NEWS_CACHE_MS = 6 * 3_600_000;
const OPENING_GRACE_MS = 3 * 60_000;
const TR_OFFSET_MS = 3 * 3_600_000;
const HOLD_HOURS = { '15m': 24, '1h': 96, '4h': 384 };

let monitorTimer = null;
let lastOpportunityRun = 0;
const newsCache = new Map(); // pair -> { at, result }
const alerted = new Set();   // aynı uyarıyı her dakika tekrar atma (trade id + tür)

const short = (err) => String(err?.message || err).slice(0, 500);
const fmt = (v) => (Number(v) >= 1 ? Number(Number(v).toFixed(4)).toString() : Number(Number(v).toPrecision(4)).toString());
const coin = (pair) => pair.replace('_USDT', '');
const pct = (a, b) => ((Number(a) / Number(b) - 1) * 100);

function notify(text, buttons) {
  return telegram.sendMessage(text, { buttons }).catch((err) => {
    console.error('Telegram hatası:', err.message);
    return null;
  });
}

function alertOnce(key, text, buttons) {
  if (alerted.has(key)) return null;
  alerted.add(key);
  return notify(text, buttons);
}

// --- Ayarlar (crypto_settings.settings.trading içinde) ---

function normalizeConfig(saved = {}) {
  return {
    enabled: !!saved.enabled,
    capitalUsdt: Math.max(0, Number(saved.capitalUsdt) || 0),
    riskProfile: PROFILES[saved.riskProfile] ? saved.riskProfile : DEFAULT_TRADING.riskProfile,
    newsMode: NEWS_MODES.includes(saved.newsMode) ? saved.newsMode : DEFAULT_TRADING.newsMode,
  };
}

async function config() {
  const state = await CryptoSignal.getState();
  return normalizeConfig(state?.settings?.trading);
}

async function holdHours() {
  const state = await CryptoSignal.getState();
  return HOLD_HOURS[state?.settings?.timeframe] || 96;
}

async function keysSet() {
  return !!((await Setting.get('gate_api_key')) && (await Setting.get('gate_api_secret')));
}

async function saveConfig(changes) {
  const state = await CryptoSignal.getState();
  const current = normalizeConfig(state?.settings?.trading);
  const next = normalizeConfig({ ...current, ...changes });
  if (next.enabled && !current.enabled) {
    if (!(await keysSet())) throw Object.assign(new Error('Önce Ayarlar sayfasından Gate.io API anahtarlarını gir.'), { status: 400 });
    if (next.capitalUsdt < MIN_ORDER_USDT * 2) {
      throw Object.assign(new Error(`Yönetilecek sermaye en az ${MIN_ORDER_USDT * 2} USDT olmalı.`), { status: 400 });
    }
    await gp.balances(['USDT']); // anahtar çalışmıyorsa açılmasın
  }
  await CryptoSignal.saveState({ settings: { ...(state?.settings || {}), trading: next } });
  if (next.enabled !== current.enabled) {
    const p = PROFILES[next.riskProfile];
    await notify(next.enabled
      ? `💰 <b>Gerçek hesap önerileri AÇIK</b>\nSermaye: ${next.capitalUsdt} USDT · ${p.label}: işlem başı %${p.riskPct} risk, ` +
        `en fazla ${p.maxPositions} pozisyon, günlük -%${p.dailyLossPct}'de öneri durur.\nHer alım için Telegram'dan onay istenecek.`
      : '⏸ <b>Gerçek hesap önerileri KAPALI</b>\nYeni öneri gelmez; açık pozisyonların borsadaki stop/hedef emirleri ve takibi devam eder.');
  }
  return next;
}

// --- Kilit: onay, takip ve tarayıcı aynı işleme aynı anda dokunmasın; ikinci süreçlere (cron) karşı DB kilidi ---

let chain = Promise.resolve();
function withTraderLock(fn) {
  const run = chain.then(async () => {
    const conn = await db.getConnection();
    try {
      const [[lock]] = await conn.query("SELECT GET_LOCK('crypto_trader', 30) AS ok");
      if (!lock.ok) throw new Error('İşlem kilidi alınamadı, biraz sonra tekrar dene.');
      try {
        return await fn();
      } finally {
        await conn.query("SELECT RELEASE_LOCK('crypto_trader')").catch(() => {});
      }
    } finally {
      conn.release();
    }
  });
  chain = run.catch(() => {});
  return run;
}

// --- Yardımcılar ---

function trDayStart(now = Date.now()) {
  const tr = new Date(now + TR_OFFSET_MS);
  return new Date(Date.UTC(tr.getUTCFullYear(), tr.getUTCMonth(), tr.getUTCDate()) - TR_OFFSET_MS);
}

function floorTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

function ceilTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.ceil(value * f - 1e-9) / f;
}

async function dailyLoss(cfg) {
  const { pnl } = await CryptoTrade.realizedSince(trDayStart());
  const limit = (cfg.capitalUsdt * PROFILES[cfg.riskProfile].dailyLossPct) / 100;
  return { reached: pnl <= -limit, pnl, limit };
}

// Yeni öneri/alım neden yapılamaz? null: yapılabilir. excludeId: onaylanan önerinin kendisi sayılmasın
async function entryBlock(cfg, pair, excludeId) {
  if (!cfg.enabled) return 'Gerçek hesap önerileri kapalı';
  if (!(await keysSet())) return 'Gate.io API anahtarı yok';
  if (cfg.capitalUsdt < MIN_ORDER_USDT * 2) return 'Sermaye tanımlı değil';
  const busy = [...(await CryptoTrade.findActive()), ...(await CryptoTrade.findProposed())].filter((t) => t.id !== excludeId);
  const profile = PROFILES[cfg.riskProfile];
  if (busy.length >= profile.maxPositions) return `En fazla ${profile.maxPositions} pozisyon (açık + onay bekleyen) dolu`;
  if (pair && busy.some((t) => t.pair === pair)) return 'Bu coinde zaten açık pozisyon/öneri var';
  const daily = await dailyLoss(cfg);
  if (daily.reached) return `Günlük zarar limiti doldu (${daily.pnl.toFixed(2)} / -${daily.limit.toFixed(2)} USDT)`;
  return null;
}

// Stop olursa kayıp ≈ sermaye x risk%; sermaye/pozisyon sayısı, kalan sermaye ve USDT bakiyesiyle sınırlı
async function positionSize(cfg, { entry, sl, isOpportunity, excludeId, minQuote }) {
  const profile = PROFILES[cfg.riskProfile];
  const stopPct = (entry - sl) / entry;
  if (!(stopPct > 0)) return { quote: 0, reason: 'Stop seviyesi geçersiz' };
  let quote = (cfg.capitalUsdt * profile.riskPct) / 100 / stopPct;
  quote = Math.min(quote, cfg.capitalUsdt / profile.maxPositions);
  const committed = [...(await CryptoTrade.findActive()), ...(await CryptoTrade.findProposed())]
    .filter((t) => t.id !== excludeId)
    .reduce((s, t) => s + Number(t.cost_usdt || t.quote_amount), 0);
  quote = Math.min(quote, cfg.capitalUsdt - committed);
  const usdt = (await gp.balances(['USDT'])).get('USDT')?.available || 0;
  quote = Math.min(quote, usdt * 0.98);
  if (isOpportunity) quote *= OPPORTUNITY_SIZE_FACTOR;
  quote = floorTo(quote, 2);
  const min = Math.max(MIN_ORDER_USDT, minQuote || 0);
  if (quote < min) return { quote, reason: `Kullanılabilir tutar yetersiz (${quote} < ${min} USDT; bakiye ${usdt.toFixed(2)} USDT)` };
  return { quote, riskUsdt: quote * stopPct };
}

// --- Haber filtresi ve fırsatlar (tarayıcı çağırır) ---

async function newsCheck(pair) {
  const cfg = await config();
  if (cfg.newsMode === 'off') return { avoid: false, reason: null };
  const cached = newsCache.get(pair);
  if (cached && Date.now() - cached.at < NEWS_CACHE_MS) return cached.result;
  try {
    const result = await news.checkCoin(pair);
    newsCache.set(pair, { at: Date.now(), result });
    return result;
  } catch (err) {
    // Haber kontrolü çalışmazsa teknik sinyal geçerli kalır; öneride not olarak görünür
    console.error(`Haber kontrolü hatası (${pair}):`, err.message);
    return { avoid: false, reason: `Haber kontrol edilemedi: ${short(err).slice(0, 120)}` };
  }
}

// Aday listesine eklenecek fırsat coinleri: base -> sebep
async function opportunityBases() {
  const cfg = await config();
  if (cfg.newsMode !== 'veto+opportunities') return new Map();
  const rows = await CryptoOpportunity.listActive().catch(() => []);
  return new Map(rows.map((r) => [r.symbol, r.reason]));
}

async function refreshOpportunities(tickers) {
  const cfg = await config();
  if (cfg.newsMode !== 'veto+opportunities' || Date.now() - lastOpportunityRun < OPPORTUNITY_EVERY_MS) return;
  lastOpportunityRun = Date.now();
  try {
    const found = await news.findOpportunities();
    const volumes = new Map(tickers.map((t) => [t.currency_pair, Number(t.quote_volume)]));
    const kept = found.filter((c) => (volumes.get(`${c.symbol}_USDT`) || 0) >= OPPORTUNITY_MIN_VOLUME);
    for (const c of kept) await CryptoOpportunity.upsert({ ...c, expiresAt: new Date(Date.now() + OPPORTUNITY_TTL_MS) });
    await CryptoOpportunity.purgeExpired();
    if (kept.length) {
      await telegram.sendMessage(
        `📰 <b>Haber fırsatları</b> (24 saat aday listesinde, teknik sinyal yine şart):\n` +
        kept.map((c) => `• <b>${telegram.escapeHtml(c.symbol)}</b>: ${telegram.escapeHtml(c.reason)}`).join('\n'),
        { silent: true }
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Fırsat taraması hatası:', err.message);
  }
}

// --- Öneri (tarayıcı yeni sinyal ürettiğinde) ---

const proposalButtons = (id) => [[{ text: '✅ Al', data: `ct:buy:${id}` }, { text: '⏭ Geç', data: `ct:skip:${id}` }]];

// signal: { id, pair, entry_price, sl_price, tp_price }; ctx: { ticker, isOpportunity, newsNote }
function propose(signal, ctx = {}) {
  return withTraderLock(async () => {
    const cfg = await config();
    if (!cfg.enabled) return null;
    const pair = signal.pair;
    const block = await entryBlock(cfg, pair);
    if (block) {
      const today = trDayStart().toISOString();
      const key = block.startsWith('Günlük zarar') ? `daily:${today}` : `block:${signal.id}`;
      await alertOnce(key, `⏭ ${coin(pair)} sinyali için gerçek alım önerilmedi: ${telegram.escapeHtml(block)}`);
      return null;
    }
    const ask = Number(ctx.ticker?.lowest_ask);
    const bid = Number(ctx.ticker?.highest_bid);
    if (ask > 0 && bid > 0 && ((ask - bid) / ask) * 100 > MAX_SPREAD_PCT) {
      await notify(`⏭ ${coin(pair)} önerilmedi: alış-satış farkı yüksek (%${(((ask - bid) / ask) * 100).toFixed(2)})`);
      return null;
    }
    const info = await gp.pairInfo(pair);
    if (!info.tradable) {
      await notify(`⏭ ${coin(pair)} önerilmedi: Gate.io'da şu an işleme kapalı`);
      return null;
    }
    const entry = Number(signal.entry_price);
    const sl = Number(signal.sl_price);
    const tp = Number(signal.tp_price);
    const size = await positionSize(cfg, { entry, sl, isOpportunity: ctx.isOpportunity, minQuote: info.minQuote });
    if (size.reason) {
      await notify(`⏭ ${coin(pair)} önerilmedi: ${telegram.escapeHtml(size.reason)}`);
      return null;
    }

    const id = await CryptoTrade.create({
      signal_id: signal.id || null, pair, status: 'proposed', quote_amount: size.quote,
      signal_entry: entry, signal_sl: sl, signal_tp: tp,
      is_opportunity: ctx.isOpportunity ? 1 : 0, news_note: ctx.newsNote ? String(ctx.newsNote).slice(0, 500) : null,
      proposed_at: new Date(),
    });
    const messageId = await notify(
      `💡 <b>ALIM ÖNERİSİ: ${coin(pair)}/USDT</b>${ctx.isOpportunity ? ' (haber fırsatı)' : ''}\n` +
      `Tutar: <b>${size.quote.toFixed(2)} USDT</b> (piyasa emri)\n` +
      `Giriş ~${fmt(entry)} · 🎯 ${fmt(tp)} (+${pct(tp, entry).toFixed(2)}%) · 🛑 ${fmt(sl)} (${pct(sl, entry).toFixed(2)}%)\n` +
      `Stop olursa kayıp ≈ ${size.riskUsdt.toFixed(2)} USDT (sermayenin %${((size.riskUsdt / cfg.capitalUsdt) * 100).toFixed(1)}'i)\n` +
      (ctx.newsNote ? `📰 ${telegram.escapeHtml(ctx.newsNote)}\n` : '') +
      `⏱ ${PROPOSAL_TTL_MS / 60_000} dk geçerli. Onaylarsan alım + borsaya stop/hedef emri konur.`,
      proposalButtons(id)
    );
    if (messageId) await CryptoTrade.update(id, { proposal_message_id: messageId });
    return CryptoTrade.findById(id);
  }).catch((err) => {
    console.error('Öneri hatası:', err.message);
    notify(`❌ ${coin(signal.pair)} önerisi hazırlanamadı: ${telegram.escapeHtml(short(err))}`);
    return null;
  });
}

// --- Onaylanan alım ---

async function waitFilled(pair, order) {
  for (let i = 0; i < 10 && order.status === 'open'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    order = await gp.getOrder(pair, order.id);
  }
  return order;
}

// Borsaya stop ve hedef emirlerini koyar. Stop konamazsa satış YAPMAZ: kullanıcıyı "Acil sat" butonuyla uyarır,
// takip her dakika tekrar dener.
async function placeProtection(trade) {
  const info = await gp.pairInfo(trade.pair);
  const amount = Number(trade.amount);
  const sl = floorTo(Number(trade.sl_price), info.pricePrecision);
  const tp = ceilTo(Number(trade.tp_price), info.pricePrecision);
  const expiresSec = Math.round((await holdHours()) * 3600 + 24 * 3600);
  const fields = { sl_price: sl, tp_price: tp };
  // Tetik seviyesi fiyatın yanlış tarafındaysa emir konduğu an tetiklenir; konmaz, kullanıcıya sorulur
  const last = await lastPrice(trade.pair);
  const sell = [[{ text: '🚨 Sat', data: `ct:sell:${trade.id}` }]];
  if (!trade.sl_order_id && last && last <= sl) {
    await alertOnce(`belowsl:${trade.id}`,
      `🚨 <b>${coin(trade.pair)}</b> fiyatı (${fmt(last)}) stop seviyesinin (${fmt(sl)}) altında, borsada stop emri yok.`, sell);
    await CryptoTrade.update(trade.id, fields);
    return;
  }
  if (!trade.tp_order_id && last && last >= tp) {
    await alertOnce(`abovetp:${trade.id}`,
      `🎯 <b>${coin(trade.pair)}</b> hedefin (${fmt(tp)}) üstünde (${fmt(last)}). Kârı almak istersen sat:`,
      [[{ text: 'Sat', data: `ct:sell:${trade.id}` }]]);
    trade = { ...trade, tp_order_id: 'skip' };
  }

  if (!trade.sl_order_id) {
    try {
      fields.sl_order_id = await gp.createStop({ pair: trade.pair, side: 'sell', rule: '<=', triggerPrice: sl, amount, expiresSec });
      alerted.delete(`nostop:${trade.id}`);
    } catch (err) {
      await alertOnce(`nostop:${trade.id}`,
        `🚨 <b>${coin(trade.pair)} pozisyonunun STOP emri konamadı</b> (${telegram.escapeHtml(short(err))}).\n` +
        'Bot her dakika tekrar deniyor. Riski kapatmak istersen sat:',
        [[{ text: '🚨 Acil sat', data: `ct:sell:${trade.id}` }]]);
    }
  }
  if (!trade.tp_order_id) {
    try {
      fields.tp_order_id = await gp.createStop({ pair: trade.pair, side: 'sell', rule: '>=', triggerPrice: tp, amount, expiresSec });
    } catch (err) {
      await alertOnce(`notp:${trade.id}`, `⚠️ ${coin(trade.pair)} hedef emri konamadı, tekrar denenecek: ${telegram.escapeHtml(short(err))}`);
    }
  }
  await CryptoTrade.update(trade.id, fields);
}

// Alım emri dolduktan sonra: gerçek dolum fiyatına göre stop/hedefi kur ve borsaya koy (kurtarmada da kullanılır)
async function completeEntry(trade, order) {
  const base = coin(trade.pair);
  const info = await gp.pairInfo(trade.pair);
  const feeInBase = order.feeCurrency === base ? order.fee : 0;
  const received = order.filledBase - feeInBase;
  const bal = (await gp.balances([base])).get(base);
  const amount = floorTo(Math.min(received, bal ? bal.available : received), info.amountPrecision);
  const entryPrice = order.avgPrice;
  const cost = order.filledQuote + (order.feeCurrency === 'USDT' ? order.fee : 0);
  // Stop/hedef mesafesi sinyalin ATR'sinden gelir; gerçek dolum fiyatına göre yeniden kurulur
  const slDist = Number(trade.signal_entry) - Number(trade.signal_sl);
  const tpDist = Number(trade.signal_tp) - Number(trade.signal_entry);

  await CryptoTrade.update(trade.id, {
    status: 'open', entry_order_id: order.id, amount, entry_price: entryPrice, cost_usdt: cost,
    sl_price: entryPrice - slDist, tp_price: entryPrice + tpDist, opened_at: new Date(),
  });
  if (!(amount > 0) || amount < info.minBase) {
    await alertOnce(`tiny:${trade.id}`, `⚠️ ${base} alındı ama miktar (${amount}) stop koymak için çok küçük. Elle kontrol et.`);
    return;
  }
  await placeProtection(await CryptoTrade.findById(trade.id));
  const done = await CryptoTrade.findById(trade.id);
  await notify(
    `🟢 <b>ALINDI: ${base}/USDT</b>${trade.is_opportunity ? ' (haber fırsatı)' : ''}\n` +
    `${fmt(amount)} ${base} · ort. ${fmt(entryPrice)} · ${cost.toFixed(2)} USDT\n` +
    `🎯 Hedef ${fmt(done.tp_price)} (+${pct(done.tp_price, entryPrice).toFixed(2)}%) ${done.tp_order_id ? '✓ borsada' : '✗'}\n` +
    `🛑 Stop ${fmt(done.sl_price)} (${pct(done.sl_price, entryPrice).toFixed(2)}%) ${done.sl_order_id ? '✓ borsada' : '✗ KONAMADI'}`,
    [[{ text: 'Sat', data: `ct:sell:${trade.id}` }]]
  );
}

// Kullanıcı "Al" dedi (Telegram veya panel)
function approve(id) {
  return withTraderLock(async () => {
    const trade = await CryptoTrade.findById(id);
    if (!trade || trade.status !== 'proposed') throw Object.assign(new Error('Öneri artık geçerli değil.'), { status: 409 });
    if (Date.now() - new Date(trade.proposed_at).getTime() > PROPOSAL_TTL_MS) {
      await CryptoTrade.transition(id, 'proposed', { status: 'expired' });
      throw Object.assign(new Error('Önerinin süresi doldu.'), { status: 409 });
    }
    const cfg = await config();
    const block = await entryBlock(cfg, trade.pair, id);
    if (block) throw Object.assign(new Error(block), { status: 409 });

    // Onay anındaki fiyat: sinyalden çok kaçtıysa ya da stopun altındaysa alma
    const last = await lastPrice(trade.pair);
    if (last && pct(last, trade.signal_entry) > MAX_CHASE_PCT) {
      await CryptoTrade.transition(id, 'proposed', { status: 'expired', error: 'Fiyat kaçtı' });
      throw Object.assign(new Error(`Fiyat sinyalden %${pct(last, trade.signal_entry).toFixed(1)} yukarı kaçtı, alınmadı.`), { status: 409 });
    }
    if (last && last <= Number(trade.signal_sl)) {
      await CryptoTrade.transition(id, 'proposed', { status: 'expired', error: 'Fiyat stopun altında' });
      throw Object.assign(new Error('Fiyat stop seviyesinin altına inmiş, alınmadı.'), { status: 409 });
    }
    // Tutar onay anındaki bakiye/sermayeye göre yeniden sınırlanır
    const info = await gp.pairInfo(trade.pair);
    const size = await positionSize(cfg, {
      entry: Number(trade.signal_entry), sl: Number(trade.signal_sl), isOpportunity: trade.is_opportunity, excludeId: id, minQuote: info.minQuote,
    });
    if (size.reason) throw Object.assign(new Error(size.reason), { status: 409 });
    const quote = Math.min(Number(trade.quote_amount), size.quote);

    if (!(await CryptoTrade.transition(id, 'proposed', { status: 'opening', quote_amount: quote, opened_at: new Date() }))) {
      throw Object.assign(new Error('Öneri zaten işleniyor.'), { status: 409 });
    }
    let order;
    try {
      order = await gp.marketBuy(trade.pair, quote, `t-bot${id}`);
    } catch (err) {
      if (err.rejected) {
        await CryptoTrade.update(id, { status: 'fail', error: short(err), closed_at: new Date() });
        throw Object.assign(new Error(`Alım emri reddedildi: ${short(err)}`), { status: 502 });
      }
      // Cevap alınamadı: emir gerçekleşmiş olabilir. Tekrar denenmez (çift alım riski);
      // takip birkaç dakika içinde emri kendi kimliğimizle bulup stopu koyar.
      await CryptoTrade.update(id, { error: `Belirsiz: ${short(err)}` });
      throw Object.assign(new Error(`Gate.io cevap vermedi; emir gerçekleşmiş olabilir, 3 dk içinde kontrol edilip stop konacak. (${short(err)})`), { status: 504 });
    }
    await CryptoTrade.update(id, { entry_order_id: order.id });
    order = await waitFilled(trade.pair, order).catch(() => order);
    if (!(order.filledBase > 0)) {
      await CryptoTrade.update(id, { status: 'fail', error: `Emir dolmadı (${order.status})`, closed_at: new Date() });
      throw Object.assign(new Error(`Alım emri dolmadı (${order.status}).`), { status: 502 });
    }
    await completeEntry({ ...trade, quote_amount: quote }, order);
    return CryptoTrade.findById(id);
  });
}

async function reject(id) {
  if (!(await CryptoTrade.transition(id, 'proposed', { status: 'rejected' }))) {
    throw Object.assign(new Error('Öneri artık geçerli değil.'), { status: 409 });
  }
}

// --- Satış (sadece kullanıcı isteğiyle; stop/hedef zaten borsada) ---

function sellProceeds(order) {
  return order.filledQuote - (order.feeCurrency === 'USDT' ? order.fee : 0);
}

async function finalize(trade, reason, { exitOrderId, exitPrice, proceeds }) {
  const cost = Number(trade.cost_usdt) || 0;
  // Önceki kısmi satışların geliri (yarım dolan stop/satış) eklenir
  proceeds += Number(trade.proceeds_usdt) || 0;
  const pnl = proceeds - cost;
  await CryptoTrade.update(trade.id, {
    status: 'closed', exit_reason: reason, exit_order_id: exitOrderId || null, exit_price: exitPrice || null,
    proceeds_usdt: proceeds, pnl_usdt: pnl, pnl_pct: cost ? (pnl / cost) * 100 : null, closed_at: new Date(),
  });
  const icon = { tp: '✅ HEDEF', sl: '🛑 STOP', expired: '⌛ SÜRE DOLDU', manual: '✋ SATILDI', external: '👤 HESAPTAN SATILMIŞ', emergency: '🚨 ACİL SATIŞ' }[reason];
  await notify(
    `${icon} (gerçek): <b>${coin(trade.pair)}</b>\n` +
    `Giriş ${fmt(trade.entry_price)} → Çıkış ${exitPrice ? fmt(exitPrice) : '?'}\n` +
    `Sonuç: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT</b> (${cost ? ((pnl / cost) * 100).toFixed(2) : '?'}%, komisyon dahil)`
  );
}

async function cancelStops(trade) {
  for (const id of [trade.sl_order_id, trade.tp_order_id]) {
    if (id) await gp.cancelStop(id).catch(() => {}); // zaten tetiklenmiş/iptal olabilir
  }
}

async function lastPrice(pair) {
  const tickers = await gate.fetchTickers().catch(() => []);
  return Number(tickers.find((t) => t.currency_pair === pair)?.last) || null;
}

// Kullanıcı "Sat" dedi: borsadaki stop/hedef iptal edilir, bot miktarı piyasadan satılır
async function sellNow(trade, reason) {
  if (!(await CryptoTrade.transition(trade.id, trade.status, { status: 'closing' }))) return;
  await cancelStops(trade);
  const base = coin(trade.pair);
  const info = await gp.pairInfo(trade.pair);
  const bal = (await gp.balances([base])).get(base);
  const sellAmount = floorTo(Math.min(Number(trade.amount) || 0, bal?.available || 0), info.amountPrecision);
  if (!(sellAmount > 0) || sellAmount < info.minBase) {
    const last = await lastPrice(trade.pair);
    return finalize(trade, 'external', { exitPrice: last, proceeds: (Number(trade.amount) || 0) * (last || 0) });
  }
  let order;
  try {
    order = await gp.marketSell(trade.pair, sellAmount, `t-bot${trade.id}s${Date.now() % 1e6}`);
  } catch (err) {
    // Satış olmadı: stop/hedef iptal edildiği için pozisyon açık ve korumasız; açık duruma döndür, takip korumayı geri koyar
    await CryptoTrade.update(trade.id, { status: 'open', sl_order_id: null, tp_order_id: null, error: `Satış: ${short(err)}` });
    throw err;
  }
  order = await waitFilled(trade.pair, order).catch(() => order);
  return settleSell(trade, reason, order, sellAmount);
}

// Satış/stop emri yarım dolduysa (derinlik yetersiz) kalan miktar açık kalır ve yeniden korumaya alınır
async function settleSell(trade, reason, order, targetAmount) {
  const info = await gp.pairInfo(trade.pair);
  const remaining = floorTo(Number(trade.amount) - order.filledBase, info.amountPrecision);
  const last = order.avgPrice || (await lastPrice(trade.pair)) || 0;
  const meaningful = remaining >= info.minBase && remaining * last >= Math.max(info.minQuote, 1) && order.filledBase < targetAmount * 0.98;
  if (!meaningful) {
    return finalize(trade, reason, { exitOrderId: order.id, exitPrice: order.avgPrice, proceeds: sellProceeds(order) });
  }
  const proceedsSoFar = (Number(trade.proceeds_usdt) || 0) + sellProceeds(order);
  await CryptoTrade.update(trade.id, {
    status: 'open', amount: remaining, proceeds_usdt: proceedsSoFar, sl_order_id: null, tp_order_id: null,
  });
  await notify(`⚠️ <b>${coin(trade.pair)}</b> satışı yarım doldu (${fmt(order.filledBase)} satıldı, ${fmt(remaining)} kaldı). Kalan için stop/hedef yeniden konuyor.`,
    [[{ text: 'Kalanı sat', data: `ct:sell:${trade.id}` }]]);
  await placeProtection(await CryptoTrade.findById(trade.id));
}

function sell(id) {
  return withTraderLock(async () => {
    const trade = await CryptoTrade.findById(id);
    if (!trade || !['open', 'closing'].includes(trade.status)) throw Object.assign(new Error('Açık pozisyon bulunamadı.'), { status: 404 });
    const expired = Date.now() - new Date(trade.opened_at).getTime() > (await holdHours()) * 3_600_000;
    await sellNow(trade, expired ? 'expired' : 'manual');
    return CryptoTrade.findById(id);
  });
}

// Kullanıcı panelde "Tümünü sat": önerileri kapatır, bot pozisyonlarını satar
async function closeAll() {
  await saveConfig({ enabled: false });
  return withTraderLock(async () => {
    for (const p of await CryptoTrade.findProposed()) await CryptoTrade.transition(p.id, 'proposed', { status: 'rejected' });
    const active = (await CryptoTrade.findActive()).filter((t) => t.status === 'open' || t.status === 'closing');
    for (const trade of active) {
      await sellNow(trade, 'emergency').catch((err) => notify(`❌ ${coin(trade.pair)} satış hatası: ${telegram.escapeHtml(short(err))}`));
    }
    return active.length;
  });
}

// --- Takip (dakikada bir; satış kararı vermez, sadece borsadaki emirleri izler ve korur) ---

async function monitorTrade(trade, prices) {
  // Alım sırasında süreç çöktüyse: emir dolmuşsa korumaya al
  if (trade.status === 'opening') {
    const startedAt = new Date(trade.opened_at || trade.proposed_at).getTime();
    if (Date.now() - startedAt < OPENING_GRACE_MS) return;
    const order = trade.entry_order_id
      ? await gp.getOrder(trade.pair, trade.entry_order_id)
      : await gp.findOrderByText(trade.pair, `t-bot${trade.id}`, Math.floor(startedAt / 1000) - 120);
    if (order && order.status === 'open') return; // hâlâ işleniyor
    if (order && order.filledBase > 0) {
      await notify(`🔎 ${coin(trade.pair)} alımı bulundu (cevap gecikmişti); stop/hedef konuyor.`);
      return completeEntry(trade, order);
    }
    await CryptoTrade.update(trade.id, { status: 'fail', error: 'Alım emri bulunamadı (gerçekleşmedi)', closed_at: new Date() });
    await notify(`ℹ️ ${coin(trade.pair)} alım emri Gate.io'da bulunamadı; alım gerçekleşmemiş.`);
    return;
  }
  if (trade.status === 'closing') {
    // Satış yarıda kaldıysa kullanıcıya sor (bot kendiliğinden satmaz)
    return alertOnce(`closing:${trade.id}`, `⚠️ ${coin(trade.pair)} satışı yarıda kaldı. Tekrar dene:`, [[{ text: 'Sat', data: `ct:sell:${trade.id}` }]]);
  }

  // Borsadaki stop/hedef tetiklendi mi?
  const stops = [{ reason: 'sl', id: trade.sl_order_id }, { reason: 'tp', id: trade.tp_order_id }];
  for (const s of stops) s.info = s.id ? await gp.getStop(s.id).catch(() => null) : null;
  const fired = stops.find((s) => s.info?.status === 'finish' && s.info.firedOrderId);
  if (fired) {
    if (!(await CryptoTrade.transition(trade.id, 'open', { status: 'closing' }))) return;
    const other = stops.find((s) => s !== fired);
    if (other.id) await gp.cancelStop(other.id).catch(() => {});
    const order = await waitFilled(trade.pair, await gp.getOrder(trade.pair, fired.info.firedOrderId));
    return settleSell(trade, fired.reason, order, Number(trade.amount));
  }

  const last = prices.get(trade.pair);
  // Coin hesaptan elle satılmışsa takibi bırak
  const base = coin(trade.pair);
  const bal = (await gp.balances([base])).get(base);
  if (((bal?.available || 0) + (bal?.locked || 0)) < Number(trade.amount) * 0.5) {
    if (!(await CryptoTrade.transition(trade.id, 'open', { status: 'closing' }))) return;
    await cancelStops(trade);
    return finalize(trade, 'external', { exitPrice: last, proceeds: Number(trade.amount) * (last || 0) });
  }

  // Stop/hedef emri iptal edilmiş, başarısız ya da süresi dolmuşsa yeniden koy
  const dead = (s) => s.id && (!s.info || ['cancelled', 'failed', 'expired'].includes(s.info.status));
  const fix = {};
  if (dead(stops[0])) fix.sl_order_id = null;
  if (dead(stops[1])) fix.tp_order_id = null;
  if (Object.keys(fix).length || !trade.sl_order_id || !trade.tp_order_id) {
    if (Object.keys(fix).length) await CryptoTrade.update(trade.id, fix);
    if ((fix.sl_order_id === null || !trade.sl_order_id) && last && last <= Number(trade.sl_price)) {
      await alertOnce(`belowsl:${trade.id}`,
        `🚨 <b>${coin(trade.pair)}</b> fiyatı (${fmt(last)}) stop seviyesinin (${fmt(trade.sl_price)}) altında ve borsada stop emri yok.`,
        [[{ text: '🚨 Sat', data: `ct:sell:${trade.id}` }]]);
    } else {
      await placeProtection({ ...trade, ...fix });
    }
  }

  // Süre doldu: sor (bot kendiliğinden satmaz)
  if (!trade.expiry_notified && Date.now() - new Date(trade.opened_at).getTime() > (await holdHours()) * 3_600_000) {
    await CryptoTrade.update(trade.id, { expiry_notified: 1 });
    const pnl = last ? pct(last, trade.entry_price) : null;
    await notify(
      `⌛ <b>${coin(trade.pair)}</b> pozisyonunun tutma süresi doldu (strateji bu noktada satar).` +
      (pnl !== null ? ` Şu an ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%.` : '') +
      '\nStop/hedef emirleri borsada durmaya devam ediyor.',
      [[{ text: 'Sat', data: `ct:sell:${trade.id}` }, { text: 'Tut', data: `ct:keep:${trade.id}` }]]
    );
  }
}

async function expireProposals() {
  for (const p of await CryptoTrade.findProposed()) {
    if (Date.now() - new Date(p.proposed_at).getTime() > PROPOSAL_TTL_MS) {
      if (await CryptoTrade.transition(p.id, 'proposed', { status: 'expired' })) {
        await telegram.clearButtons(p.proposal_message_id);
      }
    }
  }
}

async function monitor() {
  await expireProposals();
  const active = await CryptoTrade.findActive();
  if (!active.length || !(await keysSet())) return;
  const tickers = await gate.fetchTickers().catch(() => []);
  const prices = new Map(tickers.map((t) => [t.currency_pair, Number(t.last)]));
  await withTraderLock(async () => {
    for (const trade of await CryptoTrade.findActive()) {
      await monitorTrade(trade, prices).catch((err) => console.error(`Gerçek işlem #${trade.id} takip hatası:`, err.message));
    }
  });
}

// Telegram butonları: ct:buy:<id>, ct:skip:<id>, ct:sell:<id>, ct:keep:<id>
telegram.onCallback('ct', async ([action, idText], query) => {
  const id = Number(idText);
  const messageId = query.message?.message_id;
  if (action === 'buy') {
    await telegram.clearButtons(messageId);
    try {
      const trade = await approve(id);
      return `Alındı: ${coin(trade.pair)}`;
    } catch (err) {
      await notify(`⚠️ Öneri #${id} alınmadı: ${telegram.escapeHtml(short(err))}`);
      return 'Alınmadı';
    }
  }
  if (action === 'skip') {
    await reject(id).catch(() => {});
    await telegram.clearButtons(messageId);
    return 'Geçildi';
  }
  if (action === 'sell') {
    await telegram.clearButtons(messageId);
    try {
      await sell(id);
      return 'Satıldı';
    } catch (err) {
      await notify(`⚠️ #${id} satılamadı: ${telegram.escapeHtml(short(err))}`, [[{ text: 'Tekrar dene', data: `ct:sell:${id}` }]]);
      return 'Satılamadı';
    }
  }
  if (action === 'keep') {
    await telegram.clearButtons(messageId);
    return 'Tutuluyor; stop/hedef borsada';
  }
  return 'Bilinmeyen işlem';
});

function start() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => monitor().catch((err) => console.error('Gerçek işlem takibi hatası:', err.message)), MONITOR_MS);
  monitor().catch(() => {});
}

// --- Panel ---

async function testConnection() {
  const map = await gp.balances(['USDT']);
  return { usdt: map.get('USDT')?.available || 0 };
}

async function status() {
  const cfg = await config();
  const hasKeys = await keysSet();
  const trades = await CryptoTrade.list(40);
  const open = trades.filter((t) => t.status === 'open');
  const tickers = open.length ? await gate.fetchTickers().catch(() => []) : [];
  const prices = new Map(tickers.map((t) => [t.currency_pair, Number(t.last)]));
  let balanceUsdt = null;
  let balanceError = null;
  if (hasKeys) {
    balanceUsdt = await testConnection().then((b) => b.usdt).catch((err) => {
      balanceError = short(err);
      return null;
    });
  }
  const daily = await dailyLoss(cfg);
  return {
    config: cfg,
    profiles: PROFILES,
    newsModes: NEWS_MODES,
    keysSet: hasKeys,
    balanceUsdt,
    balanceError,
    todayPnl: daily.pnl,
    dailyLimit: daily.limit,
    blocked: await entryBlock(cfg),
    stats: await CryptoTrade.stats(),
    opportunities: cfg.newsMode === 'veto+opportunities' ? await CryptoOpportunity.listActive().catch(() => []) : [],
    trades: trades.map((t) => {
      const last = prices.get(t.pair);
      if (t.status !== 'open' || !last || !Number(t.cost_usdt)) return t;
      const value = Number(t.amount) * last;
      return { ...t, last_price: last, unrealized_usdt: value - Number(t.cost_usdt), unrealized_pct: (value / Number(t.cost_usdt) - 1) * 100 };
    }),
  };
}

module.exports = {
  PROFILES, NEWS_MODES, OPPORTUNITY_MIN_VOLUME, start, status, saveConfig, propose, approve, reject, sell, closeAll,
  newsCheck, opportunityBases, refreshOpportunities, testConnection,
  _monitor: monitor, // testler için
};
