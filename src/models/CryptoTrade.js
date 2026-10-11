const { db } = require('../config/db');

const parse = (row) => row && { ...row, is_opportunity: !!row.is_opportunity, expiry_notified: !!row.expiry_notified };

async function create(trade) {
  const [result] = await db.query('INSERT INTO crypto_trades SET ?', [trade]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM crypto_trades WHERE id = ?', [id]);
  return parse(rows[0]);
}

// Botun yönettiği (henüz kapanmamış) işlemler
async function findActive() {
  const [rows] = await db.query("SELECT * FROM crypto_trades WHERE status IN ('opening','open','closing') ORDER BY id");
  return rows.map(parse);
}

// Onay bekleyen öneriler; pozisyon/sermaye sınırına bunlar da sayılır (aynı anda onaylanınca sınır aşılmasın)
async function findProposed() {
  const [rows] = await db.query("SELECT * FROM crypto_trades WHERE status = 'proposed' ORDER BY id");
  return rows.map(parse);
}

// İptali doğrulanamamış stop emirleri olan işlemler (kapanmış olsalar bile): takip iptali tekrar dener
async function findPendingCancels() {
  const [rows] = await db.query('SELECT * FROM crypto_trades WHERE pending_cancel IS NOT NULL ORDER BY id');
  return rows.map(parse);
}

async function list(limit = 50) {
  const [rows] = await db.query('SELECT * FROM crypto_trades ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map(parse);
}

async function update(id, fields) {
  await db.query('UPDATE crypto_trades SET ? WHERE id = ?', [fields, id]);
}

// Sadece beklenen durumdaysa günceller; iki süreç aynı işlemi iki kez kapatmasın
async function transition(id, from, fields) {
  const [result] = await db.query('UPDATE crypto_trades SET ? WHERE id = ? AND status = ?', [fields, id, from]);
  return result.affectedRows === 1;
}

// Gerçekleşmiş kâr/zarar (USDT) — günlük zarar limiti için
async function realizedSince(date) {
  const [[row]] = await db.query(
    "SELECT COALESCE(SUM(pnl_usdt), 0) AS pnl, COUNT(*) AS n FROM crypto_trades WHERE status = 'closed' AND closed_at >= ?",
    [date]
  );
  return { pnl: Number(row.pnl), count: Number(row.n) };
}

async function stats() {
  const [[row]] = await db.query(`
    SELECT COUNT(*) AS closed, SUM(pnl_usdt > 0) AS wins, COALESCE(SUM(pnl_usdt), 0) AS pnl,
           AVG(pnl_pct) AS avgPct, MIN(opened_at) AS since
    FROM crypto_trades WHERE status = 'closed'
  `);
  const closed = Number(row.closed) || 0;
  return {
    closed,
    wins: Number(row.wins) || 0,
    winRate: closed ? (Number(row.wins) / closed) * 100 : null,
    pnlUsdt: Number(row.pnl),
    avgPct: row.avgPct === null ? null : Number(row.avgPct),
    since: row.since,
  };
}

module.exports = { create, findById, findActive, findProposed, findPendingCancels, list, update, transition, realizedSince, stats };
