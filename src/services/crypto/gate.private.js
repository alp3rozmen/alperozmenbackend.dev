const crypto = require('crypto');
const axios = require('axios');
const Setting = require('../../models/Setting');

// Gate.io API v4 imzalı (hesap) istekleri. Sadece klasik spot hesap; para çekme uç noktası bilerek yok.
// Kaynak: resmi API v4 dokümanı ve gateapi-nodejs (Ekim 2026'da doğrulandı).
// GATE_API_HOST: Gate testnet (https://api-testnet.gateapi.io) ya da test için sahte sunucu
const HOST = process.env.GATE_API_HOST || 'https://api.gateio.ws';
const PREFIX = '/api/v4';

let clockOffsetMs = 0;       // sunucu saati - yerel saat (imza zamanı ±60 sn içinde olmalı)
let clockCheckedAt = 0;
let accountModeCheckedAt = 0;
let accountMode = null;
const pairCache = new Map(); // pair -> { at, info }
const PAIR_CACHE_MS = 60 * 60_000;

async function credentials() {
  const key = await Setting.get('gate_api_key');
  const secret = await Setting.get('gate_api_secret');
  if (!key || !secret) throw new Error('Gate.io API anahtarı tanımlı değil (Ayarlar sayfası)');
  return { key, secret };
}

async function syncClock() {
  if (Date.now() - clockCheckedAt < 10 * 60_000) return;
  try {
    const { data } = await axios.get(`${HOST}${PREFIX}/spot/time`, { timeout: 10_000 });
    clockOffsetMs = Number(data.server_time) - Date.now();
    clockCheckedAt = Date.now();
  } catch {
    // saat alınamazsa yerel saatle devam
  }
}

// İmza: HexEncode(HMAC_SHA512(secret, METHOD\n/api/v4/yol\nsorgu\nHexEncode(SHA512(gövde))\nzaman))
// Sorgu URL-kodlanmadan, istekteki sırayla; gövde gönderilen JSON metninin aynısı (yoksa boş metnin özeti).
function sign(secret, method, path, query, body, timestamp) {
  const bodyHash = crypto.createHash('sha512').update(body || '').digest('hex');
  const payload = [method, PREFIX + path, query, bodyHash, timestamp].join('\n');
  return crypto.createHmac('sha512', secret).update(payload).digest('hex');
}

// Gate hata gövdesi { label, message }. label varsa Gate isteği kesin REDDETTİ demektir (emir oluşmadı);
// label yoksa (ağ hatası, zaman aşımı, 5xx) emrin oluşup oluşmadığı belirsizdir.
function friendly(err) {
  const label = err.response?.data?.label;
  const message = err.response?.data?.message || err.message;
  const map = {
    INVALID_KEY: 'API key geçersiz',
    INVALID_SIGNATURE: 'API secret hatalı (imza geçersiz)',
    FORBIDDEN: 'API anahtarının bu işlem için izni yok (spot işlem izni ver)',
    READ_ONLY: 'API anahtarı salt okunur (spot işlem izni ver)',
    IP_FORBIDDEN: 'Sunucu IP\'si API anahtarının izinli IP listesinde değil',
    BALANCE_NOT_ENOUGH: 'Bakiye yetersiz',
    AMOUNT_TOO_LITTLE: 'Tutar Gate.io alt sınırının altında',
    INVALID_PRECISION: 'Ondalık hassasiyeti hatalı',
    REQUEST_EXPIRED: 'Sunucu saati Gate.io ile uyuşmuyor',
    TOO_MANY_REQUESTS: 'Gate.io istek sınırı aşıldı',
    TRADE_RESTRICTED: 'Hesapta işlem kısıtlaması var',
    ACCOUNT_LOCKED: 'Hesap kilitli',
  };
  const out = new Error(label ? `${map[label] || label}: ${message}` : `Gate.io'ya ulaşılamadı: ${message}`);
  out.label = label || null;
  out.rejected = !!label && (err.response?.status || 0) < 500;
  return out;
}

async function request(method, path, { query = {}, body } = {}) {
  await syncClock();
  const { key, secret } = await credentials();
  // Sorgu elle kurulur (imzadaki metinle URL'deki aynı olsun); değerlerimiz sade (çift adı, sayı, durum)
  const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('&');
  const payload = body ? JSON.stringify(body) : '';
  const timestamp = String(Math.floor((Date.now() + clockOffsetMs) / 1000));
  try {
    const { data } = await axios({
      method,
      url: `${HOST}${PREFIX}${path}${qs ? `?${qs}` : ''}`,
      data: payload || undefined,
      timeout: 20_000,
      transformRequest: [(d) => d], // imzalanan metin aynen gönderilsin
      // Emir kimlikleri int64; JSON.parse 2^53'ü aşanları bozar. Kimlik alanları ayrıştırmadan önce metne çevrilir.
      transformResponse: [(raw) => {
        if (typeof raw !== 'string' || !raw) return raw;
        return JSON.parse(raw.replace(/"(id|fired_order_id)"\s*:\s*(\d+)/g, '"$1":"$2"'));
      }],
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        KEY: key,
        Timestamp: timestamp,
        SIGN: sign(secret, method.toUpperCase(), path, qs, payload, timestamp),
      },
    });
    return data;
  } catch (err) {
    throw friendly(err);
  }
}

// Sayıyı borsanın istediği düz ondalık metne çevirir (JS 1e-7 gibi üstel yazmasın), aşağı yuvarlar
function dec(value, decimals) {
  const f = 10 ** decimals;
  const floored = Math.floor(Number(value) * f + 1e-9) / f;
  return floored.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// --- Hesap ---

// Unified hesap modunda emir/bakiye uç noktaları farklı; bot şimdilik klasik spot hesapla çalışır
async function assertClassicAccount() {
  if (Date.now() - accountModeCheckedAt < 60 * 60_000) {
    if (accountMode && accountMode !== 'classic') throw unifiedError();
    return;
  }
  try {
    const data = await request('GET', '/unified/unified_mode');
    accountMode = data?.mode || 'classic';
  } catch {
    accountMode = 'classic'; // uç nokta/izin yoksa klasik hesap varsayılır
  }
  accountModeCheckedAt = Date.now();
  if (accountMode !== 'classic') throw unifiedError();
}

function unifiedError() {
  return Object.assign(new Error(`Gate.io hesabın "${accountMode}" (Unified) modunda; bot şimdilik klasik spot hesapla çalışıyor.`), { rejected: true });
}

// currencies verilirse sadece onlar; dönüş Map(currency -> { available, locked })
async function balances(currencies) {
  await assertClassicAccount();
  const query = currencies?.length === 1 ? { currency: currencies[0] } : {};
  const rows = await request('GET', '/spot/accounts', { query });
  const map = new Map(rows.map((r) => [r.currency, { available: Number(r.available) || 0, locked: Number(r.locked) || 0 }]));
  for (const c of currencies || []) if (!map.has(c)) map.set(c, { available: 0, locked: 0 });
  return map;
}

// --- Çift bilgisi (herkese açık; önbellekli) ---

async function pairInfo(pair) {
  const cached = pairCache.get(pair);
  if (cached && Date.now() - cached.at < PAIR_CACHE_MS) return cached.info;
  const { data } = await axios.get(`${HOST}${PREFIX}/spot/currency_pairs/${pair}`, { timeout: 10_000 });
  const status = data.trade_status;
  const info = {
    amountPrecision: Number(data.amount_precision),
    pricePrecision: Number(data.precision),
    minBase: Number(data.min_base_amount) || 0,
    minQuote: Number(data.min_quote_amount) || 0,
    canBuy: (status === 'tradable' || status === 'buyable') && data.type !== 'premarket' && !data.delisting_time,
    canSell: status === 'tradable' || status === 'sellable',
  };
  info.tradable = info.canBuy && info.canSell;
  pairCache.set(pair, { at: Date.now(), info });
  return info;
}

// --- Emirler ---

// Ortak biçim: { id, status (open|closed|cancelled), finishAs, filledBase, filledQuote, avgPrice, fee, feeCurrency, text }
function normalizeOrder(o) {
  const filledQuote = Number(o.filled_total) || 0;
  let filledBase = Number(o.filled_amount);
  let avgPrice = Number(o.avg_deal_price) || 0;
  if (!Number.isFinite(filledBase) || filledBase < 0) {
    // filled_amount yoksa: satışta miktar - kalan; alışta (kalan USDT cinsinden) harcanan / ortalama fiyat
    filledBase = o.side === 'sell' ? Number(o.amount) - Number(o.left || 0) : (avgPrice ? filledQuote / avgPrice : 0);
  }
  if (!avgPrice && filledBase) avgPrice = filledQuote / filledBase;
  return {
    id: String(o.id),
    status: o.status,
    finishAs: o.finish_as,
    side: o.side,
    filledBase: filledBase || 0,
    filledQuote,
    avgPrice,
    fee: Number(o.fee) || 0,
    feeCurrency: o.fee_currency,
    gtFee: Number(o.gt_fee) || 0, // GT ile komisyon indirimi açıksa komisyon burada (GT cinsinden)
    text: o.text,
    createTime: Number(o.create_time_ms) / 1000 || Number(o.create_time) || 0,
  };
}

// Kendi emir kimliğimiz: "t-" + en fazla 28 karakter [0-9A-Za-z_.-]
function textId(text) {
  if (!/^t-[0-9A-Za-z_.-]{1,28}$/.test(text)) throw new Error(`Geçersiz emir kimliği: ${text}`);
  return text;
}

// Piyasa alımı: amount = harcanacak USDT (çiftin fiyat hassasiyetine ve en fazla 2 ondalığa aşağı yuvarlanır)
async function marketBuy(pair, quoteAmount, text) {
  const info = await pairInfo(pair);
  if (!info.canBuy) throw Object.assign(new Error(`${pair} şu an alıma kapalı`), { rejected: true });
  const order = await request('POST', '/spot/orders', {
    body: {
      text: textId(text), currency_pair: pair, type: 'market', account: 'spot', side: 'buy',
      amount: dec(quoteAmount, Math.min(2, info.pricePrecision)), time_in_force: 'ioc',
    },
  });
  return normalizeOrder(order);
}

// Piyasa satışı: amount = satılacak coin miktarı (miktar hassasiyetine aşağı yuvarlanır)
async function marketSell(pair, baseAmount, text) {
  const info = await pairInfo(pair);
  if (!info.canSell) throw Object.assign(new Error(`${pair} şu an satışa kapalı`), { rejected: true });
  const order = await request('POST', '/spot/orders', {
    body: {
      text: textId(text), currency_pair: pair, type: 'market', account: 'spot', side: 'sell',
      amount: dec(baseAmount, info.amountPrecision), time_in_force: 'ioc',
    },
  });
  return normalizeOrder(order);
}

async function getOrder(pair, id) {
  return normalizeOrder(await request('GET', `/spot/orders/${id}`, { query: { currency_pair: pair } }));
}

// Alım isteğine cevap alınamadıysa (zaman aşımı) emir oluşmuş olabilir: kendi kimliğimizle son emirlerde ara.
// Gate'te text ile doğrudan sorgu sadece açık emirde çalışıyor; bu yüzden listede istemci tarafında eşleştirilir.
async function findOrderByText(pair, text, sinceSec) {
  const finished = await request('GET', '/spot/orders', {
    query: { currency_pair: pair, status: 'finished', limit: 100, from: sinceSec },
  });
  const hit = finished.find((o) => o.text === text);
  if (hit) return normalizeOrder(hit);
  const open = await request('GET', '/spot/orders', { query: { currency_pair: pair, status: 'open', limit: 100 } });
  const pending = open.find((o) => o.text === text);
  return pending ? normalizeOrder(pending) : null;
}

// Belirli bir zamandan beri tamamlanmış SATIŞ emirleri (tetiklenen emrin kimliğiyle sorgu çalışmazsa gerçek çıkışı bulmak için)
async function findSellsSince(pair, sinceSec) {
  const rows = await request('GET', '/spot/orders', { query: { currency_pair: pair, status: 'finished', limit: 100, from: sinceSec } });
  return rows.filter((o) => o.side === 'sell').map(normalizeOrder).filter((o) => o.filledBase > 0);
}

// --- Tetikli emirler (stop / hedef); borsada durur, tetiklenince piyasa emri verir ---
// rule '<=': fiyat bu seviyeye inince (stop); '>=': çıkınca (hedef). Bakiye kilitlenmez; tetiklenince kontrol edilir.
async function createStop({ pair, side = 'sell', rule, triggerPrice, amount, expiresSec }) {
  const info = await pairInfo(pair);
  const price = dec(triggerPrice, info.pricePrecision);
  const data = await request('POST', '/spot/price_orders', {
    body: {
      market: pair,
      trigger: { price, rule, expiration: Math.round(expiresSec) },
      // put.price zorunlu alan (market emirde de); account klasik spot için "normal"
      put: { type: 'market', side, price, amount: dec(amount, info.amountPrecision), account: 'normal', time_in_force: 'ioc' },
    },
  });
  return String(data.id_string || data.id);
}

function normalizeStop(data) {
  const fired = data.fired_order_id && String(data.fired_order_id) !== '0' ? String(data.fired_order_id) : null;
  return { status: data.status, firedOrderId: fired, reason: data.reason || null };
}

// Dönüş: { status: open|cancelled|finish|failed|expired, firedOrderId, reason }. Bulunamazsa label ORDER_NOT_FOUND ile hata.
async function getStop(id) {
  return normalizeStop(await request('GET', `/spot/price_orders/${id}`));
}

// İptali DOĞRULANMIŞ olarak yapar: Gate artık "open" demiyorsa döner (cancelled / finish / failed / expired / gone);
// emin olunamazsa hata fırlatır (çağıran stopu canlı saymalı). Tetiklenmişse firedOrderId döner.
async function cancelStopConfirmed(id) {
  try {
    const data = await request('DELETE', `/spot/price_orders/${id}`);
    if (data?.status && data.status !== 'open') return normalizeStop(data);
  } catch (err) {
    if (err.label === 'ORDER_NOT_FOUND') return { status: 'gone', firedOrderId: null };
  }
  const state = await getStop(id); // hata verirse çağırana gider: iptal doğrulanamadı
  if (state.status === 'open') throw new Error(`Stop ${id} iptal edilemedi (hâlâ açık)`);
  return state;
}

// Bu çift için borsada açık duran tetikli satış emirleri (oluşturma isteği zaman aşımına uğradıysa emri bulmak için)
async function findStop({ pair, rule, triggerPrice, amount }) {
  const info = await pairInfo(pair);
  const rows = await request('GET', '/spot/price_orders', { query: { status: 'open', market: pair, account: 'normal' } });
  const price = dec(triggerPrice, info.pricePrecision);
  const qty = dec(amount, info.amountPrecision);
  const hit = rows.find((r) => r.put?.side === 'sell' && r.trigger?.rule === rule
    && dec(r.trigger?.price, info.pricePrecision) === price && dec(r.put?.amount, info.amountPrecision) === qty);
  return hit ? String(hit.id_string || hit.id) : null;
}

module.exports = {
  balances, pairInfo, marketBuy, marketSell, getOrder, findOrderByText, findSellsSince, createStop, getStop, cancelStopConfirmed, findStop,
  _sign: sign, _dec: dec,
  _resetAccountMode: () => { accountModeCheckedAt = 0; }, // testler için
};
