const api = require('./shopier.api');
const ShopierBatch = require('../../models/ShopierBatch');
const log = require('../logger');

// Limit dakikada 200 istek; her ürün 2 istek (oku + yaz) olduğu için araya bekleme konur
const ITEM_DELAY_MS = 700;
const MAX_ITEMS = 2000;
const MAX_PRICE = 10_000_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shopier fiyatları string döner ("149.90")
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const fmt = (n) => Number(n).toFixed(2);
const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;
const validPrice = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < MAX_PRICE;
const variantKey = (v) => (v.selectionId || []).join(',');

// Panelin ihtiyacı olan alanlar
function slim(p) {
  const media = [...(p.media || [])].sort((a, b) => (a.placement || 9) - (b.placement || 9));
  return {
    id: String(p.id),
    title: p.title || '',
    url: p.url || null,
    image: media[0]?.url || null,
    type: p.type,
    currency: p.priceData?.currency || 'TRY',
    price: toNumber(p.priceData?.price),
    discount: !!p.priceData?.discount,
    discountedPrice: toNumber(p.priceData?.discountedPrice),
    shippingPrice: toNumber(p.priceData?.shippingPrice),
    shippingPayer: p.shippingPayer || null,
    stockStatus: p.stockStatus || null,
    stockQuantity: p.stockQuantity ?? null,
    variants: (p.variants || []).map((v) => ({
      key: variantKey(v),
      title: (v.selectionTitle || []).join(' / '),
      price: toNumber(v.priceData?.price),
    })),
  };
}

async function listProducts() {
  return (await api.listProducts()).map(slim);
}

// İstek gövdesindeki kalemleri doğrular; hatalıysa mesaj fırlatır
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw Object.assign(new Error('Güncellenecek ürün yok.'), { status: 400 });
  if (items.length > MAX_ITEMS) throw Object.assign(new Error(`Tek seferde en fazla ${MAX_ITEMS} ürün.`), { status: 400 });
  const seen = new Set();
  return items.map((it) => {
    const productId = String(it?.productId || '').trim();
    const bad = (why) => Object.assign(new Error(`"${it?.title || productId}": ${why}`), { status: 400 });
    if (!productId || seen.has(productId)) throw bad('ürün kimliği eksik ya da tekrarlı.');
    seen.add(productId);
    if (!validPrice(it.newPrice)) throw bad('yeni fiyat geçersiz.');
    if (it.newDiscounted != null && !validPrice(it.newDiscounted)) throw bad('indirimli fiyat geçersiz.');
    const variants = (Array.isArray(it.variants) ? it.variants : []).map((v) => {
      if (!validPrice(v?.new)) throw bad('varyant fiyatı geçersiz.');
      return { key: String(v.key || ''), title: String(v.title || ''), new: v.new, expected: toNumber(v.expected) };
    });
    return {
      productId, title: String(it.title || ''), newPrice: it.newPrice, newDiscounted: it.newDiscounted ?? null,
      expectedPrice: toNumber(it.expectedPrice), variants,
    };
  });
}

// Tek ürün: güncel halini oku, beklenen fiyatla uyuşuyorsa yeni fiyatı yaz, dönen cevabı doğrula
async function applyItem(row, item) {
  const fresh = await api.getProduct(item.productId);
  const before = slim(fresh);
  const variants = item.variants.map((v) => ({ ...v, old: before.variants.find((b) => b.key === v.key)?.price ?? null }));
  const record = { oldPrice: before.price, oldDiscounted: before.discount ? before.discountedPrice : null, variants: variants.length ? variants : null };

  // Liste yüklendikten sonra fiyat değiştiyse (başka sekme, Shopier paneli) üstüne yazma: zam iki kez binmesin
  if (item.expectedPrice !== null && !same(before.price, item.expectedPrice)) {
    await ShopierBatch.finishItem(row.id, { ...record, status: 'skipped', error: `Fiyat bu arada değişmiş (şimdi ${before.price}), atlandı.` });
    return;
  }

  // priceData olduğu gibi geri gönderilir (API'nin PUT'ta eksik alanı sıfırlayıp sıfırlamadığı belgelenmemiş); currency ürün düzeyinde gönderilmez
  const priceData = { price: fmt(item.newPrice) };
  for (const key of ['vatPercent', 'discount', 'discountedPrice', 'shippingPrice']) {
    const value = fresh.priceData?.[key];
    if (value !== undefined && value !== null && value !== '') priceData[key] = value;
  }
  if (before.discount && item.newDiscounted !== null) priceData.discountedPrice = fmt(item.newDiscounted);
  const body = { priceData };

  if (variants.length && fresh.variants?.length) {
    body.variants = fresh.variants.map((v) => {
      const target = variants.find((t) => t.key === variantKey(v));
      const out = {
        selectionId: v.selectionId,
        stockQuantity: v.stockQuantity,
        priceData: { currency: v.priceData?.currency || before.currency, price: target ? fmt(target.new) : v.priceData?.price },
        primary: !!v.primary,
      };
      if (v.media?.length) out.media = v.media.map((m) => ({ type: m.type || 'image', url: m.url }));
      return out;
    });
  }

  const updated = await api.updateProduct(item.productId, body);
  const after = slim(updated || {});

  // Güncelleme fiyat dışında bir şeyi bozduysa (başlık, görsel, varyant kaybı) geri kalan ürünlere devam etme
  if (after.title !== before.title || (updated?.media || []).length < (fresh.media || []).length || after.variants.length !== before.variants.length) {
    await ShopierBatch.finishItem(row.id, { ...record, status: 'error', error: 'Güncelleme ürünün fiyat dışındaki alanlarını değiştirdi.' });
    throw Object.assign(new Error(`"${before.title}" güncellenirken fiyat dışındaki alanlar (başlık/görsel/varyant) değişti. Ürünü Shopier panelinden kontrol et.`), { abort: true });
  }
  if (!same(after.price, item.newPrice)) {
    await ShopierBatch.finishItem(row.id, { ...record, status: 'error', error: `Shopier yeni fiyatı uygulamadı (dönen fiyat: ${after.price}).` });
    return;
  }
  await ShopierBatch.finishItem(row.id, { ...record, status: 'ok' });
}

// Aynı anda tek toplu işlem: iki işlem aynı ürünlere çakışmasın, istek limiti aşılmasın
let runningId = null;

async function run(batchId, items) {
  const batch = await ShopierBatch.get(batchId);
  const rows = new Map(batch.items.map((r) => [r.productId, r]));
  let note = null;
  let status = 'done';
  try {
    for (const item of items) {
      const row = rows.get(item.productId);
      try {
        await applyItem(row, item);
      } catch (err) {
        if (err.abort || err.status === 401) throw err; // oturum düştüyse kalanlar da başarısız olur
        await ShopierBatch.finishItem(row.id, { status: 'error', error: err.message });
      }
      await sleep(ITEM_DELAY_MS);
    }
  } catch (err) {
    status = 'aborted';
    note = String(err.message).slice(0, 500);
    log.error('shopier', `Toplu fiyat işlemi #${batchId} durduruldu: ${err.message}`);
  }
  await ShopierBatch.finish(batchId, status, note);
  log.info('shopier', `Toplu fiyat işlemi #${batchId} bitti (${status})`);
}

async function start(label, rawItems, revertOf = null) {
  const items = normalizeItems(rawItems);
  if (runningId) throw Object.assign(new Error(`Devam eden bir toplu işlem var (#${runningId}).`), { status: 409 });
  runningId = -1; // kayıt oluşturulurken ikinci istek araya girmesin
  try {
    runningId = await ShopierBatch.create(String(label || 'Toplu fiyat güncelleme'), items, revertOf);
  } catch (err) {
    runningId = null;
    throw err;
  }
  const id = runningId;
  run(id, items)
    .catch((err) => {
      log.error('shopier', `Toplu fiyat işlemi #${id} hata verdi: ${err.message}`);
      return ShopierBatch.finish(id, 'aborted', String(err.message).slice(0, 500)).catch(() => {});
    })
    .finally(() => { runningId = null; });
  return id;
}

// Başarıyla değişen ürünleri eski fiyatına döndürür; sonradan elle değiştirilmiş fiyatlara dokunmaz
async function revert(batchId) {
  const batch = await ShopierBatch.get(batchId);
  if (!batch) throw Object.assign(new Error('İşlem bulunamadı.'), { status: 404 });
  if (batch.status === 'running') throw Object.assign(new Error('İşlem hâlâ sürüyor.'), { status: 409 });
  const items = batch.items
    .filter((it) => it.status === 'ok' && it.oldPrice !== null)
    .map((it) => ({
      productId: it.productId,
      title: it.title,
      newPrice: it.oldPrice,
      newDiscounted: it.oldDiscounted,
      expectedPrice: it.newPrice,
      variants: it.variants.filter((v) => v.old != null).map((v) => ({ key: v.key, title: v.title, new: v.old })),
    }));
  if (items.length === 0) throw Object.assign(new Error('Geri alınacak başarılı güncelleme yok.'), { status: 400 });
  return start(`Geri alma: #${batch.id} ${batch.label}`, items, batch.id);
}

module.exports = { listProducts, start, revert };
