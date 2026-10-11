const mock = require('./.mockgate');
const axios = require('axios');
const M = 'http://127.0.0.1:5096';
const telegram = require('./src/services/telegram');
const gate = require('./src/services/crypto/gate.api');
const msgs = [];
let handler;
telegram.onCallback = (p, h) => { handler = h; };
telegram.sendMessage = async (t, o = {}) => { msgs.push({ t, buttons: o.buttons }); return 1000 + msgs.length; };
telegram.clearButtons = async () => {};
gate.fetchTickers = async () => Object.entries(mock.S.prices).map(([p, v]) => ({ currency_pair: p, last: String(v), lowest_ask: String(v), highest_bid: String(v * 0.9995), quote_volume: '9e7' }));
const Setting = require('./src/models/Setting');
const trader = require('./src/services/crypto/trader.service');
const CryptoTrade = require('./src/models/CryptoTrade');
const { db } = require('./src/config/db');
const last = () => msgs[msgs.length - 1];
const price = (p) => axios.post(`${M}/mock/price`, { pair: 'SOL_USDT', price: p });
const set = (o) => axios.post(`${M}/mock/set`, o);
const state = async () => (await axios.get(`${M}/mock/state`)).data;
const show = (label) => console.log(`\n### ${label}`);
const press = async (data) => { const [p, ...a] = data.split(':'); return handler(a, { message: { message_id: 1 } }); };
const sig = (entry, sl, tp) => ({ id: null, pair: 'SOL_USDT', entry_price: entry, sl_price: sl, tp_price: tp });
const tk = { lowest_ask: '100', highest_bid: '99.95' };

(async () => {
  await mock.start(5096);
  await Setting.setMany({ gate_api_key: 'testkey', gate_api_secret: 'testsecret' });
  const [[row]] = await db.query("SELECT value FROM app_settings WHERE `key`='gate_api_secret'");
  console.log('DB\'deki secret şifreli mi:', row.value.startsWith('enc:v1:'), '| çözülen:', await Setting.get('gate_api_secret'));

  show('Kapalıyken öneri yok');
  console.log(await trader.propose(sig(100, 96, 108), { ticker: tk }));

  show('Açma (sermaye 100, dengeli)');
  console.log((await trader.saveConfig({ enabled: true, capitalUsdt: 100 })).enabled, '|', last().t.split('\n')[0]);

  show('1) Öneri → Telegram Al → alım + borsaya stop/hedef');
  const p1 = await trader.propose(sig(100, 96, 108), { ticker: tk, newsNote: 'Haber: sorun yok' });
  console.log('öneri tutarı', p1.quote_amount, '| butonlar', JSON.stringify(last().buttons));
  console.log('Telegram:', await press(last().buttons[0][0].data));
  let t1 = await CryptoTrade.findById(p1.id);
  console.log('durum', t1.status, 'miktar', t1.amount, 'giriş', t1.entry_price, 'maliyet', t1.cost_usdt, 'SL', t1.sl_price, 'TP', t1.tp_price);
  console.log('borsadaki emirler', JSON.stringify((await state()).stops));
  console.log('SL id (2^53 üstü korunmuş mu):', t1.sl_order_id);

  show('2) Fiyat 95.5 → stop tetiklenir → takip kapatır, hedefi iptal eder');
  await price(95.5); await trader._monitor();
  t1 = await CryptoTrade.findById(p1.id);
  console.log('durum', t1.status, t1.exit_reason, 'çıkış', t1.exit_price, 'gelir', t1.proceeds_usdt, 'kâr/zarar', t1.pnl_usdt, t1.pnl_pct + '%');
  console.log('emirler', JSON.stringify((await state()).stops.map((s) => s.status)), '| mesaj:', last().t.split('\n')[0]);

  show('3) Yarım dolan hedef → kalan için yeniden koruma, sonra elle sat');
  await price(100);
  const p2 = await trader.propose(sig(100, 96, 108), { ticker: tk });
  await press(`ct:buy:${p2.id}`);
  await set({ sellFillRatio: 0.5 }); await price(108.5); await trader._monitor();
  let t2 = await CryptoTrade.findById(p2.id);
  console.log('durum', t2.status, 'kalan', t2.amount, 'şimdiye kadar gelir', t2.proceeds_usdt, '| yeni SL/TP', !!t2.sl_order_id, !!t2.tp_order_id);
  console.log('mesaj:', msgs.slice(-2).map((m) => m.t.split('\n')[0]).join(' || '));
  await set({ sellFillRatio: 1 });
  console.log('Telegram Sat:', await press(`ct:sell:${p2.id}`));
  t2 = await CryptoTrade.findById(p2.id);
  console.log('durum', t2.status, t2.exit_reason, 'toplam gelir', t2.proceeds_usdt, 'kâr/zarar', t2.pnl_usdt);

  show('4) Cevapsız alım (bağlantı koptu) → belirsiz → takip emri bulur, stop koyar');
  await price(100);
  const p3 = await trader.propose(sig(100, 96, 108), { ticker: tk });
  await set({ dropNextOrderResponse: true });
  try { await trader.approve(p3.id); } catch (e) { console.log('onay sonucu:', e.status, e.message.slice(0, 90)); }
  console.log('durum', (await CryptoTrade.findById(p3.id)).status);
  await db.query('UPDATE crypto_trades SET opened_at = ? WHERE id = ?', [new Date(Date.now() - 5 * 60_000), p3.id]);
  await trader._monitor();
  const t3 = await CryptoTrade.findById(p3.id);
  console.log('durum', t3.status, 'miktar', t3.amount, 'stop', !!t3.sl_order_id, '| mesaj:', msgs.slice(-2).map((m) => m.t.split('\n')[0]).join(' || '));

  show('5) Tutma süresi doldu → bir kez "Sat/Tut" sorulur, kendiliğinden satmaz');
  await db.query('UPDATE crypto_trades SET opened_at = ? WHERE id = ?', [new Date(Date.now() - 97 * 3600_000), p3.id]);
  const before = msgs.length;
  await trader._monitor(); await trader._monitor();
  console.log('yeni mesaj sayısı', msgs.length - before, '|', msgs[before]?.t.split('\n')[0], JSON.stringify(msgs[before]?.buttons), '| durum', (await CryptoTrade.findById(p3.id)).status);

  show('6) Pozisyon sınırı ve süresi dolan öneri');
  const p4 = await trader.propose({ ...sig(100, 96, 108), pair: 'SOL_USDT' }, { ticker: tk });
  console.log('aynı coinde ikinci öneri:', p4, '|', last().t);
  await db.query("UPDATE crypto_trades SET status='closed', closed_at=? WHERE id=?", [new Date(), p3.id]);
  const p5 = await trader.propose(sig(100, 96, 108), { ticker: tk });
  await db.query('UPDATE crypto_trades SET proposed_at = ? WHERE id = ?', [new Date(Date.now() - 31 * 60_000), p5.id]);
  try { await trader.approve(p5.id); } catch (e) { console.log('eski öneri onayı:', e.message); }
  console.log('durum', (await CryptoTrade.findById(p5.id)).status);

  show('7) Fiyat kaçtı');
  const p6 = await trader.propose(sig(100, 96, 108), { ticker: tk });
  await price(102);
  try { await trader.approve(p6.id); } catch (e) { console.log('onay:', e.message); }
  await price(100);

  show('8) Günlük zarar limiti (-3 USDT)');
  await db.query("INSERT INTO crypto_trades (pair,status,quote_amount,signal_entry,signal_sl,signal_tp,pnl_usdt,proposed_at,closed_at) VALUES ('X_USDT','closed',10,1,1,1,-4,?,?)", [new Date(), new Date()]);
  console.log(await trader.propose(sig(100, 96, 108), { ticker: tk }), '|', last().t);

  show('9) Tümünü sat');
  await db.query("DELETE FROM crypto_trades WHERE pair='X_USDT'");
  const p7 = await trader.propose(sig(100, 96, 108), { ticker: tk });
  await press(`ct:buy:${p7.id}`);
  console.log(await trader.closeAll(), 'pozisyon satıldı | açık mı:', (await trader.status()).config.enabled, '|', (await CryptoTrade.findById(p7.id)).exit_reason);
  console.log('borsada açık emir kaldı mı:', (await state()).stops.filter((s) => s.status === 'open').length);

  show('10) Unified hesap → engellenir');
  await set({ mode: 'multi_currency' });
  require('./src/services/crypto/gate.private')._resetAccountMode?.();
  try { await trader.testConnection(); console.log('engellenmedi!'); } catch (e) { console.log(e.message); }

  show('Özet');
  const st = await trader.status().catch((e) => ({ err: e.message }));
  console.log(JSON.stringify(st.stats || st), '| bakiye', JSON.stringify((await state()).balances));
  mock.close(); await db.end(); process.exit(0);
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
