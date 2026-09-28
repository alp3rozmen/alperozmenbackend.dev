const { db } = require('../config/db');

async function create(signal) {
  const [result] = await db.query('INSERT INTO crypto_signals SET ?', [signal]);
  return result.insertId;
}

async function findOpen() {
  const [rows] = await db.query("SELECT * FROM crypto_signals WHERE status = 'open'");
  return rows;
}

async function list({ status, limit = 100 }) {
  const where = status === 'open' ? "WHERE status = 'open'" : status === 'closed' ? "WHERE status <> 'open'" : '';
  const [rows] = await db.query(`SELECT * FROM crypto_signals ${where} ORDER BY opened_at DESC LIMIT ?`, [Number(limit)]);
  return rows;
}

// Aynı çift için bekleme süresi dolmadıysa tekrar sinyal üretme
async function recentPairs(sinceDate) {
  const [rows] = await db.query(
    "SELECT DISTINCT pair FROM crypto_signals WHERE status = 'open' OR opened_at >= ?",
    [sinceDate]
  );
  return new Set(rows.map((r) => r.pair));
}

async function update(id, fields) {
  await db.query('UPDATE crypto_signals SET ? WHERE id = ?', [fields, id]);
}

async function stats() {
  const [[row]] = await db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'open') AS open,
      SUM(status <> 'open') AS closed,
      SUM(status <> 'open' AND pnl_pct > 0) AS wins,
      AVG(CASE WHEN status <> 'open' THEN pnl_pct END) AS avgPnl,
      SUM(CASE WHEN status <> 'open' THEN pnl_pct END) AS totalPnl,
      MIN(opened_at) AS since
    FROM crypto_signals
  `);
  const closed = Number(row.closed) || 0;
  return {
    total: Number(row.total) || 0,
    open: Number(row.open) || 0,
    closed,
    wins: Number(row.wins) || 0,
    winRate: closed ? (Number(row.wins) / closed) * 100 : null,
    avgPnl: row.avgPnl === null ? null : Number(row.avgPnl),
    totalPnl: row.totalPnl === null ? 0 : Number(row.totalPnl),
    since: row.since,
  };
}

async function getState() {
  const [[row]] = await db.query('SELECT * FROM crypto_settings WHERE id = 1');
  return row ? { ...row, running: !!row.running, settings: row.settings ? JSON.parse(row.settings) : {} } : null;
}

async function saveState(fields) {
  const data = { ...fields };
  if (data.settings) data.settings = JSON.stringify(data.settings);
  await db.query('INSERT INTO crypto_settings SET id = 1, ? ON DUPLICATE KEY UPDATE ?', [data, data]);
}

module.exports = { create, findOpen, list, recentPairs, update, stats, getState, saveState };
