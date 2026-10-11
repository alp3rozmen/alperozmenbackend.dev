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
const USER_SOL = 5; // kullanıcının kendi SOL'ü: bot buna asla dokunmamalı
const last = () => msgs[msgs.length - 1];
const price = (p) => axios.post(`${M}/mock/price`, { pair: 'SOL_USDT', price: p });
const set = (o) => axios.post(`${M}/mock/set`, o);
const state = async () => (await axios.get(`${M}/mock/state`)).data;
const openStops = async () => (await state()).stops.filter((s) => s.status === 'open');
const show = (label) => console.log(`\n### ${label}`);
const press = (data) => { const [, ...a] = data.split(':'); return trader._onButton(a, { message: { message_id: 1 } }); };
const sig = () => ({ id: null, pair: 'SOL_USDT', entry_price: 100, sl_price: 96, tp_price: 108 });
const tk = { lowest_ask: '100', highest_bid: '99.95' };
const t = (id) => CryptoTrade.findById(id);
const botSol = async () => (await CryptoTrade.findActive()).reduce((s, x) => s + Number(x.amount || 0), 0);
const userSolCheck = async (label) => {
  const sol = (await state()).balances.SOL || 0;
  const expect = USER_SOL + (await botSol());
  console.log(`  [${label}] SOL bakiye ${sol.toFixed(4)} | kullanıcı(5)+bot ${expect.toFixed(4)} ${sol + 1e-6 >= USER_SOL ? '✓ kullanıcı coinleri yerinde' : '✗ KULLANICI COİNİ SATILDI'}`);
};
const buy = async () => { await price(100); const p = await trader.propose(sig(), { ticker: tk }); await press(`ct:buy:${p.id}`); return p.id; };

(async () => {
  await mock.start(5096);
  mock.S.balances.SOL = USER_SOL;
  await Setting.setMany({ gate_api_key: 'testkey', gate_api_secret: 'testsecret' });
  await trader.saveConfig({ enabled: true, capitalUsdt: 100 });

  show('1) Öneri → Al → stop/hedef borsada (liste kimlikleri 2^53 üstü)');
  const a = await buy();
  let x = await t(a);
  console.log('durum', x.status, 'miktar', x.amount, 'SL id', x.sl_order_id, 'TP id', x.tp_order_id, '| açık emir', (await openStops()).length);

  show('2) Stop sorgusu geçici hata (503) → çift stop KONMAMALI');
  await set({ failStopGet: true }); await trader._monitor(); await trader._monitor(); await set({ failStopGet: false });
  x = await t(a);
  console.log('açık emir sayısı', (await openStops()).length, '(2 olmalı) | id değişmedi mi', x.sl_order_id === (await t(a)).sl_order_id);

  show('3) Stop tetiklendi, takip görmeden kullanıcı "Sat" bastı → stopun satışı esas alınır, kullanıcı coini satılmaz');
  await price(95.5);
  console.log('Sat:', await press(`ct:sell:${a}`));
  x = await t(a);
  console.log('durum', x.status, x.exit_reason, 'çıkış', x.exit_price, 'kâr/zarar', x.pnl_usdt, '| açık emir', (await openStops()).length);
  await userSolCheck('3');

  show('4) Stop oluşturma cevabı kayboldu → sonraki tur emri bulur, ikinci stop KONMAZ');
  await set({ dropNextStopResponse: true });
  const b = await buy();
  x = await t(b);
  console.log('ilk tur: SL id', x.sl_order_id, 'TP id', x.tp_order_id, '| açık emir', (await openStops()).length);
  await trader._monitor();
  x = await t(b);
  console.log('takip sonrası: SL id', !!x.sl_order_id, 'TP id', !!x.tp_order_id, '| açık emir', (await openStops()).length, '(2 olmalı)');

  show('5) Hedef tetiklendi ama diğer stopun iptali başarısız → bekleyen iptal, sonra tekrar denenir');
  await set({ failCancel: true }); await price(108.5); await trader._monitor();
  x = await t(b);
  console.log('durum', x.status, x.exit_reason, 'kâr/zarar', x.pnl_usdt, '| bekleyen iptal', x.pending_cancel, '| açık emir', (await openStops()).length);
  await set({ failCancel: false }); await price(100); await trader._monitor();
  console.log('tekrar sonrası bekleyen iptal', (await t(b)).pending_cancel, '| açık emir', (await openStops()).length, '(0 olmalı)');
  await userSolCheck('5');

  show('6) Satış cevabı kayboldu → tekrar satılmaz, takip emri bulur ve kapatır');
  const c = await buy();
  await set({ dropNextOrderResponse: true });
  console.log('Sat:', await press(`ct:sell:${c}`), '|', last().t.slice(0, 90), '| tekrar butonu:', JSON.stringify(last().buttons || null));
  console.log('durum', (await t(c)).status, '| tekrar Sat:', await press(`ct:sell:${c}`));
  await trader._monitor();
  x = await t(c);
  console.log('takip sonrası', x.status, x.exit_reason, 'gelir', x.proceeds_usdt);
  await userSolCheck('6');

  show('7) İptal edilemeyen stop varken "Sat" → satış yapılmaz');
  const d = await buy();
  await set({ failCancel: true });
  console.log('Sat:', await press(`ct:sell:${d}`), '|', last().t.slice(0, 80));
  console.log('durum', (await t(d)).status, '| açık emir', (await openStops()).length);
  await set({ failCancel: false });
  console.log('Sat (iptal düzeldi):', await press(`ct:sell:${d}`), (await t(d)).status, (await t(d)).exit_reason);
  await userSolCheck('7');

  show('8) Cevapsız alım → bulunur, korunur; hemen ardından tümünü sat');
  await price(100);
  const pe = await trader.propose(sig(), { ticker: tk });
  await set({ dropNextOrderResponse: true });
  console.log('Al:', await press(`ct:buy:${pe.id}`), '| durum', (await t(pe.id)).status);
  await db.query('UPDATE crypto_trades SET opened_at = ? WHERE id = ?', [new Date(Date.now() - 4 * 60_000), pe.id]);
  await trader._monitor();
  x = await t(pe.id);
  console.log('durum', x.status, 'stop', !!x.sl_order_id);
  console.log('tümünü sat:', await trader.closeAll(), '| durum', (await t(pe.id)).status, (await t(pe.id)).exit_reason, '| açık emir', (await openStops()).length);
  await userSolCheck('8');

  show('9) Haber vetosu düzenli ifadesi');
  const re = /KARAR\W*G[İIi]R(ME)?/i;
  console.log(['KARAR: GİRME', 'KARAR: GİR', '**KARAR:** GIRME'].map((s) => `${s} → ${s.match(re)?.[1] ? 'atla' : 'gir'}`).join(' | '));

  show('Özet');
  console.log(JSON.stringify((await trader.status()).stats), '| bakiye', JSON.stringify((await state()).balances));
  mock.close(); await db.end(); process.exit(0);
})().catch((e) => { console.error('TEST HATASI', e); process.exit(1); });
