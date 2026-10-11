// Sahte Gate.io v4 sunucusu: imzayı resmi tarife göre BAĞIMSIZ doğrular, bakiye/emir/tetikli emir taklit eder
const http = require('http');
const crypto = require('crypto');
const KEY = 'testkey', SECRET = 'testsecret';
const S = {
  balances: { USDT: 1000 }, prices: { SOL_USDT: 100 }, orders: new Map(), stops: new Map(),
  nextOrder: 5_000_000_001, nextStop: 9_007_199_254_740_993n, // 2^53'ten büyük: id_string kullanılıyor mu?
  mode: 'classic', sellFillRatio: 1, dropNextOrderResponse: false, dropNextStopResponse: false, failStopGet: false, failCancel: false, log: [],
};
const PAIRS = { SOL_USDT: { id: 'SOL_USDT', min_base_amount: '0.001', min_quote_amount: '3', amount_precision: 3, precision: 2, trade_status: 'tradable', type: 'normal' } };
const bal = (c) => S.balances[c] || 0;
const add = (c, v) => { S.balances[c] = +(bal(c) + v).toFixed(12); };
function decimals(str) { return (String(str).split('.')[1] || '').length; }

function fill(o) {
  const pair = o.currency_pair, base = pair.split('_')[0], price = S.prices[pair];
  const out = { id: String(S.nextOrder++), text: o.text, currency_pair: pair, type: 'market', side: o.side, amount: o.amount, price: '0', time_in_force: o.time_in_force, status: 'closed', finish_as: 'filled', create_time: String(Math.floor(Date.now()/1000)) };
  if (o.side === 'buy') {
    const quote = Number(o.amount);
    if (quote > bal('USDT')) return { err: 'BALANCE_NOT_ENOUGH' };
    const baseAmt = +(quote / price).toFixed(8), fee = +(baseAmt * 0.002).toFixed(10);
    add('USDT', -quote); add(base, baseAmt - fee);
    Object.assign(out, { filled_amount: String(baseAmt), filled_total: String(quote), avg_deal_price: String(price), fee: String(fee), fee_currency: base, left: '0' });
  } else {
    const want = Number(o.amount);
    if (want > bal(base) + 1e-12) return { err: 'BALANCE_NOT_ENOUGH' };
    const sold = +(want * S.sellFillRatio).toFixed(8), total = +(sold * price).toFixed(8), fee = +(total * 0.002).toFixed(8);
    add(base, -sold); add('USDT', total - fee);
    Object.assign(out, { filled_amount: String(sold), filled_total: String(total), avg_deal_price: String(price), fee: String(fee), fee_currency: 'USDT', left: String(+(want - sold).toFixed(8)), finish_as: S.sellFillRatio < 1 ? 'depth_not_enough' : 'filled' });
  }
  S.orders.set(out.id, out);
  return { order: out };
}

function evaluateStops() {
  for (const st of S.stops.values()) {
    if (st.status !== 'open') continue;
    const p = S.prices[st.market];
    const hit = st.trigger.rule === '<=' ? p <= Number(st.trigger.price) : p >= Number(st.trigger.price);
    if (!hit) continue;
    const r = fill({ currency_pair: st.market, side: st.put.side, amount: st.put.amount, text: 't-stop' });
    if (r.err) { st.status = 'failed'; st.reason = r.err; } else { st.status = 'finish'; st.fired_order_id = Number(r.order.id); }
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? `__BIG${v}__` : v).replace(/"__BIG(\d+)__"/g, '$1')); };
    const path = url.pathname;
    // test kancaları (imzasız)
    if (path === '/mock/price') { const b = JSON.parse(body); S.prices[b.pair] = b.price; evaluateStops(); return send(200, { ok: true }); }
    if (path === '/mock/set') { Object.assign(S, JSON.parse(body)); return send(200, { ok: true }); }
    if (path === '/mock/state') return send(200, { balances: S.balances, stops: [...S.stops.values()].map((s) => ({ id: String(s.id), status: s.status, rule: s.trigger.rule, price: s.trigger.price, amount: s.put.amount, account: s.put.account })) });
    // herkese açık
    if (path === '/api/v4/spot/time') return send(200, { server_time: Date.now() });
    if (path.startsWith('/api/v4/spot/currency_pairs/')) return send(200, PAIRS[path.split('/').pop()]);
    // imza doğrulama (resmi tarif)
    const ts = req.headers.timestamp, q = url.search ? url.search.slice(1) : '';
    const str = [req.method, path, q, crypto.createHash('sha512').update(body).digest('hex'), ts].join('\n');
    const expect = crypto.createHmac('sha512', SECRET).update(str).digest('hex');
    if (req.headers.key !== KEY) return send(401, { label: 'INVALID_KEY', message: 'bad key' });
    if (req.headers.sign !== expect) return send(401, { label: 'INVALID_SIGNATURE', message: 'Signature mismatch' });
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) return send(401, { label: 'REQUEST_EXPIRED', message: 'expired' });
    S.log.push(`${req.method} ${path}${q ? '?' + q : ''}`);
    if (path === '/api/v4/unified/unified_mode') return send(200, { mode: S.mode });
    if (path === '/api/v4/spot/accounts') {
      const c = url.searchParams.get('currency');
      const list = Object.keys(S.balances).filter((k) => !c || k === c).map((k) => ({ currency: k, available: String(S.balances[k]), locked: '0' }));
      return send(200, list);
    }
    if (path === '/api/v4/spot/orders' && req.method === 'POST') {
      const o = JSON.parse(body);
      if (o.type !== 'market' || !['ioc', 'fok'].includes(o.time_in_force)) return send(400, { label: 'INVALID_PARAM_VALUE', message: 'market needs ioc' });
      if (!/^t-[0-9A-Za-z_.-]{1,28}$/.test(o.text)) return send(400, { label: 'INVALID_PARAM_VALUE', message: 'bad text' });
      if (o.side === 'buy' && decimals(o.amount) > 2) return send(400, { label: 'INVALID_PRECISION', message: 'quote decimals' });
      if (o.side === 'sell' && decimals(o.amount) > PAIRS[o.currency_pair].amount_precision) return send(400, { label: 'INVALID_PRECISION', message: 'amount decimals' });
      if (/e/i.test(o.amount)) return send(400, { label: 'INVALID_PARAM_VALUE', message: 'exponent' });
      const r = fill(o);
      if (r.err) return send(400, { label: r.err, message: r.err });
      if (S.dropNextOrderResponse) { S.dropNextOrderResponse = false; return req.socket.destroy(); }
      return send(201, r.order);
    }
    if (path === '/api/v4/spot/orders' && req.method === 'GET') {
      const st = url.searchParams.get('status'), pair = url.searchParams.get('currency_pair');
      return send(200, [...S.orders.values()].filter((o) => o.currency_pair === pair && (st === 'finished' ? o.status !== 'open' : o.status === 'open')));
    }
    if (path.startsWith('/api/v4/spot/orders/')) {
      const o = S.orders.get(path.split('/').pop());
      return o ? send(200, o) : send(404, { label: 'ORDER_NOT_FOUND', message: 'nf' });
    }
    if (path === '/api/v4/spot/price_orders' && req.method === 'GET') {
      // liste: kimlikler ham int64 (id_string yok) — istemci büyük sayıyı bozmadan okuyabiliyor mu?
      const m = url.searchParams.get('market');
      const rows = [...S.stops.values()].filter((st) => st.status === 'open' && (!m || st.market === m));
      return send(200, '[' + rows.map((st) => JSON.stringify({ ...st, id: '__ID__' }).replace('"__ID__"', String(st.id))).join(',') + ']');
    }
    if (path === '/api/v4/spot/price_orders' && req.method === 'POST') {
      const b = JSON.parse(body);
      if (b.put.account !== 'normal' || !b.put.price || typeof b.trigger.expiration !== 'number' || b.put.time_in_force !== 'ioc') return send(400, { label: 'INVALID_PARAM_VALUE', message: 'bad price order ' + body });
      if (/e/i.test(b.trigger.price + b.put.amount)) return send(400, { label: 'INVALID_PARAM_VALUE', message: 'exponent' });
      const id = S.nextStop++;
      S.stops.set(String(id), { ...b, id, status: 'open', fired_order_id: 0 });
      if (S.dropNextStopResponse) { S.dropNextStopResponse = false; return req.socket.destroy(); }
      return send(201, `{"id":${id},"id_string":"${id}"}`);
    }
    if (path.startsWith('/api/v4/spot/price_orders/')) {
      const st = S.stops.get(path.split('/').pop());
      if (!st) return send(404, { label: 'ORDER_NOT_FOUND', message: 'nf' });
      if (req.method === 'DELETE') {
        if (S.failCancel) return send(502, 'Bad Gateway');
        if (st.status === 'open') st.status = 'cancelled';
        return send(200, { ...st, id: String(st.id) });
      }
      if (S.failStopGet) return send(503, 'Service Unavailable');
      return send(200, { ...st, id: String(st.id) });
    }
    send(404, { label: 'NOT_FOUND', message: path });
  });
});
module.exports = { start: (port) => new Promise((r) => server.listen(port, r)), S, close: () => server.close() };
