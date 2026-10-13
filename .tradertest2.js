const mock = require('./.mockgate');
const axios = require('axios');
const M = 'http://127.0.0.1:5096';
const telegram = require('./src/services/telegram');
const gate = require('./src/services/crypto/gate.api');
const msgs = [];
telegram.onCallback = () => {};
telegram.sendMessage = async (t, o = {}) => { msgs.push({ t, buttons: o.buttons }); return 1000 + msgs.length; };
telegram.clearButtons = async () => {};
gate.fetchTickers = async () => Object.entries(mock.S.prices).map(([p, v]) => ({ currency_pair: p, last: String(v), lowest_ask: String(v), highest_bid: String(v * 0.9995), quote_volume: '9e7' }));
const Setting = require('./src/models/Setting');
const trader = require('./src/services/crypto/trader.service');
const CryptoTrade = require('./src/models/CryptoTrade');
const { db } = require('./src/config/db');
const USER_SOL = 5;
const price = (pair, p) => axios.post(`${M}/mock/price`, { pair, price: p });
const set = (o) => axios.post(`${M}/mock/set`, o);
const state = async () => (await axios.get(`${M}/mock/state`)).data;
const openStops = async () => (await state()).stops.filter((s) => s.status === 'open');
const t = (id) => CryptoTrade.findById(id);
const show = (l) => console.log(`\n### ${l}`);
const press = (data) => { const [, ...a] = data.split(':'); return trader._onButton(a, { message: { message_id: 1 } }); };
const sig = (pair = 'SOL_USDT', e = 100) => ({ id: null, pair, entry_price: e, sl_price: e * 0.96, tp_price: e * 1.08 });
const tk = (e = 100) => ({ lowest_ask: String(e), highest_bid: String(e * 0.9995), quote_volume: '9e7' });
const buy = async () => { await price('SOL_USDT', 100); const p = await trader.propose(sig(), { ticker: tk() }); await press(`ct:buy:${p.id}`); return p.id; };
const userSol = async (l) => { const sol = (await state()).balances.SOL || 0; console.log(`  [${l}] SOL ${sol.toFixed(4)} ${sol >= USER_SOL - 1e-6 ? '✓ kullanıcı coinleri yerinde' : '✗ KULLANICI COİNİ SATILMIŞ'}`); };
const last = () => msgs[msgs.length - 1];

(async () => {
  await mock.start(5096);
  mock.S.balances.SOL = USER_SOL;
  await Setting.setMany({ gate_api_key: 'testkey', gate_api_secret: 'testsecret' });
  await trader.saveConfig({ enabled: true, capitalUsdt: 100 });

  show('A) Hedef tetiklendi ama tetiklenen emir sorgusu ORDER_NOT_FOUND → karşı stop YİNE iptal, gerçek satış geçmişten bulunur');
  const a = await buy();
  await set({ failOrderGet: true }); await price('SOL_USDT', 108.5);
  await trader._monitor();
  let x = await t(a);
  console.log('durum', x.status, x.exit_reason, '| kâr/zarar', x.pnl_usdt, '| not:', x.error, '| açık emir', (await openStops()).length, '(0 olmalı)');
  await set({ failOrderGet: false }); await userSol('A');

  show('B) Hem emir sorgusu hem satış listesi çalışmıyor → tahmini tutarla KAPANIR (açık kalmaz), kullanıcıya belirtilir');
  const b = await buy();
  await set({ failOrderGet: true, failOrderList: true }); await price('SOL_USDT', 108.5);
  await trader._monitor();
  x = await t(b);
  console.log('durum', x.status, x.exit_reason, '| gelir', x.proceeds_usdt, '| açık emir', (await openStops()).length, '(0 olmalı)');
  console.log('not:', x.error); console.log('mesaj:', last().t.split('\n').slice(0, 4).join(' | '));
  await set({ failOrderGet: false, failOrderList: false }); await userSol('B');

  show('C) Web\'den Sat: pozisyon zaten kapanmış → anlaşılır mesaj');
  try { await require('./src/services/crypto/trader.service').sell(b); } catch (e) { console.log('Hata mesajı:', e.status, e.message); }

  show('D) Kapanmış işlemden kalan stop (iptali başarısız olmuş) → tarama bulur ve iptal eder');
  await price('SOL_USDT', 100);
  const d = await buy();
  const d0 = await t(d);
  // kapanmış gibi işaretle ama borsadaki emirler açık kalsın (eski hatanın bıraktığı durum)
  await db.query("UPDATE crypto_trades SET status='closed', closed_at=?, exit_reason='tp', pnl_usdt=1 WHERE id=?", [new Date(), d]);
  console.log('önce açık emir:', (await openStops()).length, '(2 olmalı)');
  trader._resetSweep(); await trader._monitor();
  x = await t(d);
  console.log('tarama sonrası açık emir:', (await openStops()).length, '(0 olmalı) | işlemin emir kimlikleri temizlendi mi:', x.sl_order_id === null && x.tp_order_id === null, '| mesaj:', msgs.find((m) => m.t.includes('kalan stop'))?.t.slice(0, 80));
  // elimizdeki SOL'ü tazele (bu işlem borsada hâlâ alınmış durumda): testi temiz tutmak için sat
  mock.S.balances.SOL = USER_SOL;

  show('E) Stop tetiklendi ama Gate satış emri üretmedi (finish, fired_order_id=0) → ölü sayılır, kullanıcı uyarılır, Sat çalışır');
  await price('SOL_USDT', 100);
  const e = await buy();
  await set({ noFireOnTrigger: true }); await price('SOL_USDT', 95); await trader._monitor();
  x = await t(e);
  console.log('durum', x.status, '| stop id:', x.sl_order_id, '| uyarı:', msgs.slice(-2).map((m) => m.t.split('\n')[0]).join(' || '));
  await set({ noFireOnTrigger: false });
  console.log('Sat:', await press(`ct:sell:${e}`), '→', (await t(e)).status, (await t(e)).exit_reason);
  await userSol('E');

  show('F) ALL-IN modu: tüm sermaye tek pozisyonda');
  await price('SOL_USDT', 100);
  try { await axios.post; } catch {}
  const cfgBefore = (await trader.status()).config;
  await trader.saveConfig({ allIn: true, capitalUsdt: 200 });
  const f = await trader.propose(sig(), { ticker: tk() });
  console.log('öneri tutarı', f.quote_amount, '(200 sermayeden ~200, bakiye 1000) | mesaj:', msgs.find((m) => m.t.includes('ALIM ÖNERİSİ')) && last().t.split('\n').slice(0, 2).join(' | '));
  const f2 = await trader.propose(sig('ETH_USDT', 3000), { ticker: tk(3000) });
  console.log('ikinci coin önerisi:', f2, '|', last().t);
  await press(`ct:buy:${f.id}`);
  x = await t(f.id);
  console.log('alım sonucu: durum', x.status, 'maliyet', x.cost_usdt, '(~200), açık emir', (await openStops()).length);
  await trader.saveConfig({ allIn: false });
  console.log('normal moda dönüş notu:', last().t.slice(0, 60));
  await press(`ct:sell:${f.id}`);

  show('G) Hacim sınırı: pozisyon 24 saatlik hacmin %0.5\'inden büyük olamaz');
  await trader.saveConfig({ allIn: true, capitalUsdt: 200 });
  const lowVol = { lowest_ask: '100', highest_bid: '99.95', quote_volume: '10000' };
  const g = await trader.propose(sig(), { ticker: lowVol });
  console.log('düşük hacimli coin için:', g === null ? `önerilmedi: ${last().t}` : `öneri tutarı ${g.quote_amount} (50 olmalı)`);
  await trader.saveConfig({ allIn: false });

  show('Özet');
  console.log(JSON.stringify((await trader.status()).stats), '| kullanıcı SOL', (await state()).balances.SOL);
  mock.close(); await db.end(); process.exit(0);
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
