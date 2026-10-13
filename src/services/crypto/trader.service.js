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
const DEFAULT_TRADING = { enabled: false, capitalUsdt: 0, riskProfile: 'balanced', newsMode: 'veto+opportunities', allIn: false };

// All-in: tüm sermaye tek pozisyonda (aynı anda en fazla 1). Kazanç da kayıp da yaklaşık katlanır.
const maxPositionsOf = (cfg) => (cfg.allIn ? 1 : PROFILES[cfg.riskProfile].maxPositions);

const MONITOR_MS = 60_000;
const PROPOSAL_TTL_MS = 30 * 60_000;  // 1 saatlik mumda kırılımdan sonraki 30 dk; sonra fiyat kaçmış olur
const MAX_CHASE_PCT = 1.5;            // onay anında fiyat sinyalden bu kadar yukarı kaçtıysa alma
const MIN_ORDER_USDT = 5;             // Gate'in alt sınırının üstü; çok küçük pozisyona stop konamaz
const MAX_SPREAD_PCT = 0.4;           // alış-satış farkı bundan büyükse önerme (kayma riski)
const MAX_VOLUME_SHARE = 0.005;       // pozisyon, coinin 24 saatlik hacminin en fazla %0.5'i (büyük bakiyede kayma olmasın)
const ALL_IN_USABLE = 0.99;           // all-in: bakiyenin %99'u (yuvarlama payı)
const OPPORTUNITY_SIZE_FACTOR = 0.5;  // haber fırsatı coinler daha az likit: yarım pozisyon
const OPPORTUNITY_MIN_VOLUME = 300_000;
const OPPORTUNITY_TTL_MS = 24 * 3_600_000;
const OPPORTUNITY_EVERY_MS = 12 * 3_600_000;
const NEWS_CACHE_MS = 6 * 3_600_000;
const OPENING_GRACE_MS = 3 * 60_000;
const TR_OFFSET_MS = 3 * 3_600_000;
const HOLD_HOURS = { '15m': 24, '1h': 96, '4h': 384 };

let monitorTimer = null;
let started = false; // sadece ana uygulamada (index.js) true; cron süreci fırsat taraması/dinleme yapmasın
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
    allIn: !!saved.allIn,
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
      ? `💰 <b>Gerçek hesap önerileri AÇIK</b>\nSermaye: ${next.capitalUsdt} USDT · ` +
        (next.allIn
          ? `🔥 ALL-IN: tüm sermaye tek pozisyonda, günlük -%${p.dailyLossPct}'de öneri durur.`
          : `${p.label}: işlem başı %${p.riskPct} risk, en fazla ${p.maxPositions} pozisyon, günlük -%${p.dailyLossPct}'de öneri durur.`) +
        `\nHer alım için Telegram'dan onay istenecek.`
      : '⏸ <b>Gerçek hesap önerileri KAPALI</b>\nYeni öneri gelmez; açık pozisyonların borsadaki stop/hedef emirleri ve takibi devam eder.');
  } else if (next.allIn !== current.allIn) {
    await notify(next.allIn
      ? '🔥 <b>ALL-IN modu AÇIK</b>: her alımda tüm sermaye (tek pozisyon) kullanılacak. Stop olursa kayıp sermayenin tamamına yakın bir yüzdesi olmaz ama stop mesafesi kadar (genelde %3-6) doğrudan sermayeden gider.'
      : '✅ ALL-IN modu kapandı: işlem başı sabit risk ve çoklu pozisyon düzenine dönüldü.');
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
  const maxPositions = maxPositionsOf(cfg);
  if (busy.length >= maxPositions) return `En fazla ${maxPositions} pozisyon (açık + onay bekleyen) dolu${cfg.allIn ? ' (all-in modu: aynı anda tek pozisyon)' : ''}`;
  if (pair && busy.some((t) => t.pair === pair)) return 'Bu coinde zaten açık pozisyon/öneri var';
  const daily = await dailyLoss(cfg);
  if (daily.reached) return `Günlük zarar limiti doldu (${daily.pnl.toFixed(2)} / -${daily.limit.toFixed(2)} USDT)`;
  return null;
}

// Stop olursa kayıp ≈ sermaye x risk%; sermaye/pozisyon sayısı, kalan sermaye ve USDT bakiyesiyle sınırlı
async function positionSize(cfg, { entry, sl, isOpportunity, excludeId, minQuote, volume24h }) {
  const profile = PROFILES[cfg.riskProfile];
  const stopPct = (entry - sl) / entry;
  if (!(stopPct > 0)) return { quote: 0, reason: 'Stop seviyesi geçersiz' };
  const committed = [...(await CryptoTrade.findActive()), ...(await CryptoTrade.findProposed())]
    .filter((t) => t.id !== excludeId)
    .reduce((s, t) => s + Number(t.cost_usdt || t.quote_amount), 0);
  const usdt = (await gp.balances(['USDT'])).get('USDT')?.available || 0;
  let quote;
  if (cfg.allIn) {
    // Tüm yönetilen sermaye tek pozisyonda (fiyat/risk hesabı yok)
    quote = Math.min(cfg.capitalUsdt - committed, usdt * ALL_IN_USABLE);
  } else {
    quote = (cfg.capitalUsdt * profile.riskPct) / 100 / stopPct;
    quote = Math.min(quote, cfg.capitalUsdt / profile.maxPositions);
    quote = Math.min(quote, cfg.capitalUsdt - committed);
    quote = Math.min(quote, usdt * 0.98);
    if (isOpportunity) quote *= OPPORTUNITY_SIZE_FACTOR;
  }
  // Likidite: pozisyon coinin 24 saatlik hacminin küçük bir kısmı olsun (piyasa emrinde kayma)
  if (volume24h > 0) quote = Math.min(quote, volume24h * MAX_VOLUME_SHARE);
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
  if (!started) return; // cron gibi kısa ömürlü süreçlerde ücretli Gemini aramasını tekrar tekrar yapma
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
    if (cfg.allIn && ctx.isOpportunity) {
      await notify(`⏭ ${coin(pair)} (haber fırsatı) önerilmedi: all-in modunda sadece normal sinyaller alınır`);
      return null;
    }
    const size = await positionSize(cfg, {
      entry, sl, isOpportunity: ctx.isOpportunity, minQuote: info.minQuote, volume24h: Number(ctx.ticker?.quote_volume),
    });
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
      `Tutar: <b>${size.quote.toFixed(2)} USDT</b> (piyasa emri)${cfg.allIn ? ' 🔥 ALL-IN' : ''}\n` +
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

// GT ile ödenen komisyonun USDT karşılığı (komisyon indirimi açıksa ücret GT'den düşer, maliyete eklenmeli)
async function gtFeeUsdt(order) {
  if (!(order.gtFee > 0)) return 0;
  return order.gtFee * ((await lastPrice('GT_USDT')) || 0);
}

// Stop durumunu okur. Sadece kesin cevaplar "yok" sayılır; geçici hatada 'unknown' döner (o tur hiçbir şey değişmez)
async function stopState(id) {
  if (!id) return { status: 'none' };
  try {
    return await gp.getStop(id);
  } catch (err) {
    return err.label === 'ORDER_NOT_FOUND' ? { status: 'gone' } : { status: 'unknown', error: short(err) };
  }
}
const DEAD = ['cancelled', 'failed', 'expired', 'gone', 'none'];
// 'finish' ama satış emri üretmemiş (tetikte hata) stop da ölüdür: koruma yeniden konur / kullanıcıya sorulur
const isDead = (s) => DEAD.includes(s.status) || (s.status === 'finish' && !s.firedOrderId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stopu doğrulayarak iptal eder; doğrulanamazsa işlemin pending_cancel listesine yazılır, takip tekrar dener.
// Dönüş: tetiklenmişse { firedOrderId }, aksi halde null
async function retireStop(trade, id) {
  if (!id) return null;
  try {
    const state = await gp.cancelStopConfirmed(id);
    return state.status === 'finish' && state.firedOrderId ? state : null;
  } catch (err) {
    const fresh = await CryptoTrade.findById(trade.id);
    const list = new Set(String(fresh.pending_cancel || '').split(',').filter(Boolean));
    list.add(String(id));
    await CryptoTrade.update(trade.id, { pending_cancel: [...list].join(',').slice(0, 500) });
    return null;
  }
}

// İptali doğrulanamamış stopları tekrar dener (kapanmış işlemlerde canlı stop kalmasın)
async function retryPendingCancels() {
  for (const trade of await CryptoTrade.findPendingCancels()) {
    const left = [];
    let lastErr = '';
    for (const id of trade.pending_cancel.split(',').filter(Boolean)) {
      try {
        await gp.cancelStopConfirmed(id);
      } catch (err) {
        left.push(id);
        lastErr = short(err);
      }
    }
    await CryptoTrade.update(trade.id, { pending_cancel: left.length ? left.join(',') : null });
    if (left.length) {
      await alertOnce(`pendingcancel:${trade.id}`,
        `⚠️ ${coin(trade.pair)} için ${left.length} stop/hedef emri iptal edilemedi (${telegram.escapeHtml(lastErr)}); bot tekrar deniyor. Gerekirse Gate.io'dan elle iptal et.`);
    }
  }
}

// Borsaya stop ve hedef emirlerini koyar. Stop konamazsa satış YAPMAZ: kullanıcıyı "Acil sat" butonuyla uyarır,
// takip her dakika tekrar dener. Önce borsada aynı emir zaten var mı bakılır (zaman aşımına uğrayan istek oluşmuş olabilir).
async function placeProtection(trade) {
  const info = await gp.pairInfo(trade.pair);
  const amount = Number(trade.amount);
  const sl = floorTo(Number(trade.sl_price), info.pricePrecision);
  const tp = ceilTo(Number(trade.tp_price), info.pricePrecision);
  const expiresSec = Math.round((await holdHours()) * 3600 + 24 * 3600);
  const fields = { sl_price: sl, tp_price: tp };
  // Tetik seviyesi fiyatın yanlış tarafındaysa emir konduğu an tetiklenir; konmaz, kullanıcıya sorulur
  const last = await lastPrice(trade.pair);
  let wantSl = !trade.sl_order_id;
  let wantTp = !trade.tp_order_id;
  if (wantSl && last && last <= sl) {
    wantSl = false;
    await alertOnce(`belowsl:${trade.id}`,
      `🚨 <b>${coin(trade.pair)}</b> fiyatı (${fmt(last)}) stop seviyesinin (${fmt(sl)}) altında, borsada stop emri yok.`,
      [[{ text: '🚨 Sat', data: `ct:sell:${trade.id}` }]]);
  }
  if (wantTp && last && last >= tp) {
    wantTp = false;
    await alertOnce(`abovetp:${trade.id}`,
      `🎯 <b>${coin(trade.pair)}</b> hedefin (${fmt(tp)}) üstünde (${fmt(last)}). Kârı almak istersen sat:`,
      [[{ text: 'Sat', data: `ct:sell:${trade.id}` }]]);
  }

  const place = async (rule, triggerPrice, key) => {
    // Önceki turda isteği zaman aşımına uğrayan emir borsada oluşmuş olabilir: varsa onu sahiplen
    const existing = await gp.findStop({ pair: trade.pair, rule, triggerPrice, amount });
    if (existing) return existing;
    try {
      return await gp.createStop({ pair: trade.pair, side: 'sell', rule, triggerPrice, amount, expiresSec });
    } catch (err) {
      if (!err.rejected) return null; // belirsiz: sonraki turda findStop ile aranır, tekrar oluşturulmaz
      throw err;
    }
  };

  if (wantSl) {
    try {
      const id = await place('<=', sl);
      if (id) {
        fields.sl_order_id = id;
        alerted.delete(`nostop:${trade.id}`);
      }
    } catch (err) {
      await alertOnce(`nostop:${trade.id}`,
        `🚨 <b>${coin(trade.pair)} pozisyonunun STOP emri konamadı</b> (${telegram.escapeHtml(short(err))}).\n` +
        'Bot her dakika tekrar deniyor. Riski kapatmak istersen sat:',
        [[{ text: '🚨 Acil sat', data: `ct:sell:${trade.id}` }]]);
    }
  }
  if (wantTp) {
    try {
      const id = await place('>=', tp);
      if (id) fields.tp_order_id = id;
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
  const cost = order.filledQuote + (order.feeCurrency === 'USDT' ? order.fee : 0) + (await gtFeeUsdt(order));
  // Stop/hedef mesafesi sinyalin ATR'sinden gelir; gerçek dolum fiyatına göre yeniden kurulur
  const slDist = Number(trade.signal_entry) - Number(trade.signal_sl);
  const tpDist = Number(trade.signal_tp) - Number(trade.signal_entry);

  await CryptoTrade.update(trade.id, {
    status: 'open', entry_order_id: order.id, amount, entry_price: entryPrice, cost_usdt: cost,
    sl_price: entryPrice - slDist, tp_price: entryPrice + tpDist, opened_at: new Date(), error: null,
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
    const ticker = await tickerOf(trade.pair);
    const last = Number(ticker?.last) || null;
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
      entry: Number(trade.signal_entry), sl: Number(trade.signal_sl), isOpportunity: trade.is_opportunity, excludeId: id,
      minQuote: info.minQuote, volume24h: Number(ticker?.quote_volume),
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
    // Alım gerçekleşti: bundan sonraki hata "alınmadı" diye bildirilmez; takip korumayı tamamlar
    try {
      await completeEntry({ ...trade, quote_amount: quote }, order);
    } catch (err) {
      await notify(`🟢 <b>${coin(trade.pair)} ALINDI</b> ama stop/hedef konurken hata oldu (${telegram.escapeHtml(short(err))}). ` +
        'Bot 1 dk içinde tekrar deneyecek.', [[{ text: 'Sat', data: `ct:sell:${id}` }]]);
    }
    return CryptoTrade.findById(id);
  });
}

async function reject(id) {
  if (!(await CryptoTrade.transition(id, 'proposed', { status: 'rejected' }))) {
    throw Object.assign(new Error('Öneri artık geçerli değil.'), { status: 409 });
  }
}

// --- Satış (sadece kullanıcı isteğiyle ya da borsadaki stop/hedef tetiklenince) ---

async function sellProceeds(order) {
  return order.filledQuote - (order.feeCurrency === 'USDT' ? order.fee : 0) - (await gtFeeUsdt(order));
}

async function finalize(trade, reason, { exitOrderId, exitPrice, proceeds, note }) {
  const cost = Number(trade.cost_usdt) || 0;
  // Önceki kısmi satışların geliri (yarım dolan stop/satış) eklenir
  proceeds += Number(trade.proceeds_usdt) || 0;
  const pnl = proceeds - cost;
  await CryptoTrade.update(trade.id, {
    status: 'closed', exit_reason: reason, exit_order_id: exitOrderId || null, exit_price: exitPrice || null,
    proceeds_usdt: proceeds, pnl_usdt: pnl, pnl_pct: cost ? (pnl / cost) * 100 : null, closed_at: new Date(),
    pending_text: null, pending_at: null,
    ...(note ? { error: String(note).slice(0, 500) } : {}),
  });
  const icon = { tp: '✅ HEDEF', sl: '🛑 STOP', expired: '⌛ SÜRE DOLDU', manual: '✋ SATILDI', external: '👤 HESAPTAN SATILMIŞ', emergency: '🚨 ACİL SATIŞ' }[reason];
  await notify(
    `${icon} (gerçek): <b>${coin(trade.pair)}</b>\n` +
    `Giriş ${fmt(trade.entry_price)} → Çıkış ${exitPrice ? fmt(exitPrice) : '?'}\n` +
    `Sonuç: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT</b> (${cost ? ((pnl / cost) * 100).toFixed(2) : '?'}%, komisyon dahil)` +
    (note ? `\n⚠️ ${telegram.escapeHtml(String(note).slice(0, 200))}` : '')
  );
}

async function tickerOf(pair) {
  const tickers = await gate.fetchTickers().catch(() => []);
  return tickers.find((t) => t.currency_pair === pair) || null;
}

async function lastPrice(pair) {
  return Number((await tickerOf(pair))?.last) || null;
}

// Satış/stop emri yarım dolduysa (derinlik yetersiz) kalan miktar açık kalır ve yeniden korumaya alınır
async function settleSell(trade, reason, order, targetAmount) {
  const info = await gp.pairInfo(trade.pair);
  const remaining = floorTo(Number(trade.amount) - order.filledBase, info.amountPrecision);
  const last = order.avgPrice || (await lastPrice(trade.pair)) || 0;
  const meaningful = remaining >= info.minBase && remaining * last >= Math.max(info.minQuote, 1) && order.filledBase < targetAmount * 0.98;
  if (!meaningful) {
    return finalize(trade, reason, { exitOrderId: order.id, exitPrice: order.avgPrice, proceeds: await sellProceeds(order) });
  }
  const proceedsSoFar = (Number(trade.proceeds_usdt) || 0) + (await sellProceeds(order));
  await CryptoTrade.update(trade.id, {
    status: 'open', amount: remaining, proceeds_usdt: proceedsSoFar, sl_order_id: null, tp_order_id: null,
    pending_text: null, pending_at: null,
  });
  await notify(`⚠️ <b>${coin(trade.pair)}</b> satışı yarım doldu (${fmt(order.filledBase)} satıldı, ${fmt(remaining)} kaldı). Kalan için stop/hedef yeniden konuyor.`,
    [[{ text: 'Kalanı sat', data: `ct:sell:${trade.id}` }]]);
  await placeProtection(await CryptoTrade.findById(trade.id));
}

// Gerçek çıkış dolumunu bulur: (1) tetiklenen emrin kimliği, (2) hesabın satış geçmişi. İkisi de olmazsa order=null.
// Tek bir sorguya bağımlı kalınmaz: bu sorgu hata verirse pozisyon "açık" kalıp karşı stop canlı kalıyordu.
async function resolveExit(trade, firedOrderId) {
  let lastErr = null;
  if (firedOrderId) {
    for (let i = 0; i < 3; i++) {
      try {
        return { order: await waitFilled(trade.pair, await gp.getOrder(trade.pair, firedOrderId)) };
      } catch (err) {
        lastErr = err;
        if (i < 2) await sleep(1500 * (i + 1));
      }
    }
  }
  // Önceki kısmi satışlar zaten hesaplandıysa geçmişten tahmin yapılmaz (çift sayım olmasın)
  if (!Number(trade.proceeds_usdt)) {
    try {
      const since = Math.floor(new Date(trade.opened_at || trade.proposed_at).getTime() / 1000) - 60;
      const sells = (await gp.findSellsSince(trade.pair, since)).sort((a, b) => a.createTime - b.createTime);
      const amount = Number(trade.amount);
      const near = (x) => Math.abs(x - amount) / amount <= 0.03;
      const single = sells.find((o) => near(o.filledBase));
      if (single) return { order: single };
      const total = sells.reduce((sum, o) => sum + o.filledBase, 0);
      if (sells.length && near(total)) {
        const quote = sells.reduce((sum, o) => sum + o.filledQuote, 0);
        return {
          order: {
            id: sells.map((o) => o.id).join('+'), status: 'closed', filledBase: total, filledQuote: quote, avgPrice: quote / total,
            fee: sells.reduce((sum, o) => sum + (o.feeCurrency === 'USDT' ? o.fee : 0), 0), feeCurrency: 'USDT',
            gtFee: sells.reduce((sum, o) => sum + o.gtFee, 0),
          },
        };
      }
    } catch (err) {
      lastErr = lastErr || err;
    }
  }
  return { order: null, error: lastErr };
}

// Çıkış verisi hiç alınamadıysa: tetik fiyatından tahmini sonuçla kapat (açık görünmeye devam etmesin), kullanıcıya belirt
async function finalizeEstimated(trade, reason, refPrice, error) {
  const price = Number(refPrice) || (await lastPrice(trade.pair)) || 0;
  return finalize(trade, reason, {
    exitPrice: price,
    proceeds: Number(trade.amount) * price * 0.998,
    note: `Çıkış tutarı tahmini (Gate emir verisi alınamadı${error ? `: ${short(error)}` : ''}). Gerçek tutar için Gate.io geçmişine bak.`,
  });
}

// Borsadaki stop/hedef tetiklendiyse. SIRA ÖNEMLİ: önce risk kapatılır (durum "closing", karşı stop doğrulanarak iptal),
// sonra muhasebe yapılır. Muhasebe sorgusunun hatası karşı stopu canlı bırakmamalı, pozisyonu açık göstermemeli.
async function settleFired(trade, fired, other) {
  if (trade.status === 'open' && !(await CryptoTrade.transition(trade.id, 'open', { status: 'closing' }))) return;
  const otherFired = await retireStop(trade, other.id);
  if (otherFired) {
    await alertOnce(`bothfired:${trade.id}`, `⚠️ ${coin(trade.pair)} için hem stop hem hedef tetiklenmiş görünüyor; Gate.io'dan bakiyeyi kontrol et.`);
  }
  const closing = { ...trade, status: 'closing' };
  const exit = await resolveExit(closing, fired.firedOrderId);
  if (exit.order) return settleSell(closing, fired.kind, exit.order, Number(trade.amount));
  return finalizeEstimated(closing, fired.kind, fired.kind === 'sl' ? trade.sl_price : trade.tp_price, exit.error);
}

async function readStops(trade) {
  // kind: bizim sl/tp etiketimiz (Gate'in yanıtındaki "reason" alanıyla karışmasın diye ayrı ad)
  const sl = { ...(await stopState(trade.sl_order_id)), kind: 'sl', id: trade.sl_order_id };
  const tp = { ...(await stopState(trade.tp_order_id)), kind: 'tp', id: trade.tp_order_id };
  return { sl, tp, unknown: [sl, tp].some((s) => s.status === 'unknown') };
}

const firedOf = ({ sl, tp }) => [sl, tp].find((s) => s.status === 'finish' && s.firedOrderId) || null;

// Kullanıcı "Sat" dedi. Kendi coinlerine dokunmamak için: tetiklenmiş stop varsa onun satışı esas alınır;
// stoplar doğrulanarak iptal edilmeden satış yapılmaz; satış cevabı belirsizse tekrar denenmez, emir aranır.
async function sellNow(trade, reason) {
  const stops = await readStops(trade);
  if (stops.unknown) throw new Error('Gate.io stop durumu okunamadı, biraz sonra tekrar dene');
  const fired = firedOf(stops);
  if (fired) return settleFired(trade, fired, fired === stops.sl ? stops.tp : stops.sl);

  if (!(await CryptoTrade.transition(trade.id, trade.status, { status: 'closing', exit_reason: reason }))) return;
  for (const s of [stops.sl, stops.tp]) {
    if (!s.id || isDead(s)) continue;
    let result;
    try {
      result = await gp.cancelStopConfirmed(s.id);
    } catch (err) {
      // Stop canlı olabilir: satış yapılmaz (aynı coin iki kez satılmasın)
      await CryptoTrade.update(trade.id, { status: 'open' });
      throw new Error(`Stop iptal edilemedi, satış yapılmadı: ${short(err)}`);
    }
    if (result.status === 'finish' && result.firedOrderId) {
      return settleFired({ ...trade, status: 'closing' }, { ...result, kind: s.kind, id: s.id }, s === stops.sl ? stops.tp : stops.sl);
    }
  }
  await CryptoTrade.update(trade.id, { sl_order_id: null, tp_order_id: null });

  const base = coin(trade.pair);
  const info = await gp.pairInfo(trade.pair);
  const bal = (await gp.balances([base])).get(base);
  const sellAmount = floorTo(Math.min(Number(trade.amount) || 0, bal?.available || 0), info.amountPrecision);
  if (!(sellAmount > 0) || sellAmount < info.minBase) {
    // Satılacak coin yok (hedef/stop ya da elle satış olmuş): gerçek çıkışı bul, yoksa tahmini kapat
    const closing = { ...trade, status: 'closing' };
    const exit = await resolveExit(closing, null);
    if (exit.order) return settleSell(closing, 'external', exit.order, Number(trade.amount));
    return finalizeEstimated(closing, 'external', await lastPrice(trade.pair), exit.error);
  }
  const text = `t-bot${trade.id}s${Date.now() % 1e6}`;
  await CryptoTrade.update(trade.id, { pending_text: text, pending_at: new Date() });
  let order;
  try {
    order = await gp.marketSell(trade.pair, sellAmount, text);
  } catch (err) {
    if (err.rejected) {
      // Kesin red: satış olmadı; açık duruma dön, takip stop/hedefi yeniden koyar
      await CryptoTrade.update(trade.id, { status: 'open', pending_text: null, pending_at: null, error: `Satış reddedildi: ${short(err)}` });
      throw err;
    }
    // Belirsiz: takip emri kimliğiyle arar; bulunamazsa 3 dk sonra açık duruma döner ve koruma yeniden konur
    throw new Error(`Gate.io cevap vermedi; satış gerçekleşmiş olabilir, kontrol ediliyor (tekrar sat'a basma). ${short(err)}`);
  }
  order = await waitFilled(trade.pair, order).catch(() => order);
  return settleSell({ ...trade, status: 'closing' }, reason, order, sellAmount);
}

function sell(id) {
  return withTraderLock(async () => {
    const trade = await CryptoTrade.findById(id);
    if (!trade) throw Object.assign(new Error('Pozisyon bulunamadı.'), { status: 404 });
    if (trade.status !== 'open') {
      const why = {
        closing: 'Satış zaten sürüyor/kontrol ediliyor.',
        closed: 'Bu pozisyon zaten kapanmış (hedef/stop ya da önceki satışla). Sayfa yenileniyor.',
        opening: 'Alım henüz tamamlanmadı.',
      }[trade.status] || `Pozisyon satılabilir durumda değil (${trade.status}).`;
      throw Object.assign(new Error(why), { status: 409 });
    }
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
    const active = (await CryptoTrade.findActive()).filter((t) => t.status === 'open');
    for (const trade of active) {
      await sellNow(trade, 'emergency').catch((err) => notify(`❌ ${coin(trade.pair)} satış hatası: ${telegram.escapeHtml(short(err))}`));
    }
    return active.length;
  });
}

// --- Takip (dakikada bir; satış kararı vermez, borsadaki emirleri izler, korur ve uzlaştırır) ---

async function reconcileClosing(trade) {
  // Belirsiz biten satış: emri kendi kimliğimizle ara
  if (trade.pending_text) {
    const since = Math.floor(new Date(trade.pending_at || Date.now()).getTime() / 1000) - 120;
    const order = await gp.findOrderByText(trade.pair, trade.pending_text, since);
    if (order && order.status === 'open') return;
    if (order) return settleSell(trade, trade.exit_reason || 'manual', order, Number(trade.amount));
    if (Date.now() - new Date(trade.pending_at).getTime() > OPENING_GRACE_MS) {
      await CryptoTrade.update(trade.id, { status: 'open', pending_text: null, pending_at: null });
      await notify(`ℹ️ ${coin(trade.pair)} satışı Gate.io'da bulunamadı; satış gerçekleşmemiş. Stop/hedef yeniden konuyor.`,
        [[{ text: 'Sat', data: `ct:sell:${trade.id}` }]]);
    }
    return;
  }
  // Süreç satıştan önce/tetik sonrası çöktü: stoplara bak
  const stops = await readStops(trade);
  if (stops.unknown) return;
  const fired = firedOf(stops);
  if (fired) return settleFired(trade, fired, fired === stops.sl ? stops.tp : stops.sl);
  // Satış olmamış: açık duruma dön (iptal edilmiş stoplar yeniden konur)
  await CryptoTrade.update(trade.id, {
    status: 'open',
    sl_order_id: isDead(stops.sl) ? null : trade.sl_order_id,
    tp_order_id: isDead(stops.tp) ? null : trade.tp_order_id,
  });
}

async function monitorTrade(trade, prices) {
  // Alım sırasında süreç çöktüyse ya da cevap gelmediyse: emir dolmuşsa korumaya al
  if (trade.status === 'opening') {
    const startedAt = new Date(trade.opened_at || trade.proposed_at).getTime();
    // Emir kimliği biliniyorsa beklemeye gerek yok; bilinmiyorsa (cevap gelmedi) Gate'in işlemesi için biraz bekle
    if (!trade.entry_order_id && Date.now() - startedAt < OPENING_GRACE_MS) return;
    const order = trade.entry_order_id
      ? await gp.getOrder(trade.pair, trade.entry_order_id)
      : await gp.findOrderByText(trade.pair, `t-bot${trade.id}`, Math.floor(startedAt / 1000) - 120);
    if (order && order.status === 'open') return; // hâlâ işleniyor
    if (order && order.filledBase > 0) {
      if (!trade.entry_order_id) await notify(`🔎 ${coin(trade.pair)} alımı bulundu (cevap gecikmişti); stop/hedef konuyor.`);
      return completeEntry(trade, order);
    }
    await CryptoTrade.update(trade.id, { status: 'fail', error: 'Alım emri bulunamadı (gerçekleşmedi)', closed_at: new Date() });
    await notify(`ℹ️ ${coin(trade.pair)} alım emri Gate.io'da dolmamış/bulunamadı; alım gerçekleşmemiş.`);
    return;
  }
  if (trade.status === 'closing') return reconcileClosing(trade);

  // Borsadaki stop/hedef tetiklendi mi? Durum okunamadıysa bu tur hiçbir şeye dokunma
  const stops = await readStops(trade);
  if (stops.unknown) return;
  const fired = firedOf(stops);
  if (fired) return settleFired(trade, fired, fired === stops.sl ? stops.tp : stops.sl);

  const last = prices.get(trade.pair);
  // Coin hesaptan elle satılmışsa takibi bırak
  const base = coin(trade.pair);
  const bal = (await gp.balances([base])).get(base);
  if (((bal?.available || 0) + (bal?.locked || 0)) < Number(trade.amount) * 0.5) {
    if (!(await CryptoTrade.transition(trade.id, 'open', { status: 'closing' }))) return;
    await retireStop(trade, trade.sl_order_id);
    await retireStop(trade, trade.tp_order_id);
    // Coin hesaptan satılmış: gerçek satışı geçmişten bul (kullanıcı elle sattıysa gerçek tutar yazılsın)
    const closing = { ...trade, status: 'closing' };
    const exit = await resolveExit(closing, null);
    if (exit.order) return settleSell(closing, 'external', exit.order, Number(trade.amount));
    return finalizeEstimated(closing, 'external', last, exit.error);
  }

  // Stop/hedef emri kesin olarak yoksa (iptal, başarısız, süresi dolmuş) yeniden koy
  const fix = {};
  if (trade.sl_order_id && isDead(stops.sl)) fix.sl_order_id = null;
  if (trade.tp_order_id && isDead(stops.tp)) fix.tp_order_id = null;
  if (Object.keys(fix).length) await CryptoTrade.update(trade.id, fix);
  const current = { ...trade, ...fix };
  if (!current.sl_order_id || !current.tp_order_id) await placeProtection(current);

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

// Kapanmış işlemlerden borsada kalmış stop/hedef emri var mı? (iptali başarısız olan, unutulan) Varsa iptal edilir.
// Her işlem bir kez doğrulanınca emir kimlikleri temizlenir; sonra tekrar sorgulanmaz.
let lastSweep = 0;
const SWEEP_MS = 5 * 60_000;
async function sweepOrphanStops() {
  if (Date.now() - lastSweep < SWEEP_MS) return;
  lastSweep = Date.now();
  for (const trade of await CryptoTrade.findClosedWithStops(new Date(Date.now() - 14 * 24 * 3_600_000))) {
    const keep = {};
    for (const key of ['sl_order_id', 'tp_order_id']) {
      const id = trade[key];
      if (!id) continue;
      const state = await stopState(id);
      if (state.status === 'unknown') {
        keep[key] = id; // okunamadı: sonraki taramada tekrar
        continue;
      }
      if (state.status === 'open') {
        await alertOnce(`orphan:${trade.id}:${id}`, `🧹 <b>${coin(trade.pair)}</b> (#${trade.id}) kapanmış işlemden kalan stop/hedef emri bulundu, iptal ediliyor.`);
        await retireStop(trade, id); // iptal edilemezse pending_cancel'a yazılır, takip tekrar dener
      }
      keep[key] = null;
    }
    if (Object.keys(keep).length) {
      const update = {};
      for (const key of ['sl_order_id', 'tp_order_id']) if (key in keep) update[key] = keep[key];
      await CryptoTrade.update(trade.id, update);
    }
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
  if (!(await keysSet())) return;
  const active = await CryptoTrade.findActive();
  const pending = await CryptoTrade.findPendingCancels();
  if (!active.length && !pending.length && Date.now() - lastSweep < SWEEP_MS) return;
  const tickers = await gate.fetchTickers().catch(() => []);
  const prices = new Map(tickers.map((t) => [t.currency_pair, Number(t.last)]));
  await withTraderLock(async () => {
    await retryPendingCancels().catch((err) => console.error('Stop iptal tekrarı hatası:', err.message));
    await sweepOrphanStops().catch((err) => console.error('Artık stop taraması hatası:', err.message));
    for (const trade of await CryptoTrade.findActive()) {
      await monitorTrade(trade, prices).catch((err) => {
        console.error(`Gerçek işlem #${trade.id} takip hatası:`, err.message);
        // Sessiz kalmasın: aynı hata bir kez Telegram'a yazılır (her dakika tekrarlanmaz)
        alertOnce(`mon:${trade.id}:${short(err).slice(0, 80)}`,
          `⚠️ <b>${coin(trade.pair)}</b> (#${trade.id}) takip hatası: ${telegram.escapeHtml(short(err))}\nBot her dakika tekrar deniyor.`);
      });
    }
  });
}

// Telegram butonları: ct:buy:<id>, ct:skip:<id>, ct:sell:<id>, ct:keep:<id>. Sadece sahibi, özel sohbetten.
async function onButton([action, idText], query) {
  const id = Number(idText);
  const messageId = query.message?.message_id;
  if (action === 'buy') {
    await telegram.clearButtons(messageId);
    try {
      const trade = await approve(id);
      return trade.status === 'open' ? `Alındı: ${coin(trade.pair)}` : `İşleniyor: ${coin(trade.pair)}`;
    } catch (err) {
      await notify(`⚠️ Öneri #${id}: ${telegram.escapeHtml(short(err))}`);
      return err.status === 504 ? 'Belirsiz, kontrol ediliyor' : 'Alınmadı';
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
      // "Tekrar dene" sadece kesin red/stop okunamadı durumunda; belirsiz satışta takip uzlaştırır
      const retry = /cevap vermedi/.test(err.message) ? undefined : [[{ text: 'Tekrar dene', data: `ct:sell:${id}` }]];
      await notify(`⚠️ #${id} satış: ${telegram.escapeHtml(short(err))}`, retry);
      return 'Satılamadı';
    }
  }
  if (action === 'keep') {
    await telegram.clearButtons(messageId);
    return 'Tutuluyor; stop/hedef borsada';
  }
  return 'Bilinmeyen işlem';
}

// Sadece ana uygulama çağırır (index.js). Cron script'i bu modülü yükler ama start etmez:
// Telegram dinleme ve takip zamanlayıcısı ikinci bir süreçte açılmasın.
function start() {
  if (monitorTimer) return;
  started = true;
  telegram.onCallback('ct', onButton, { ownerOnly: true });
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
  _monitor: monitor, _onButton: onButton, _resetSweep: () => { lastSweep = 0; }, // testler için
};
