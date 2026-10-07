const { db } = require('../config/db');

const JSON_FIELDS = ['photos', 'plan', 'scenes'];

function parse(row) {
  if (!row) return null;
  const out = { ...row, auto_publish: !!row.auto_publish };
  for (const f of JSON_FIELDS) out[f] = row[f] ? JSON.parse(row[f]) : null;
  return out;
}

function serialize(fields) {
  const out = { ...fields };
  for (const f of JSON_FIELDS) if (out[f] !== undefined && out[f] !== null) out[f] = JSON.stringify(out[f]);
  return out;
}

async function create(video) {
  const [result] = await db.query('INSERT INTO product_videos SET ?', [serialize(video)]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM product_videos WHERE id = ?', [id]);
  return parse(rows[0]);
}

async function findByToken(token) {
  const [rows] = await db.query('SELECT * FROM product_videos WHERE public_token = ?', [token]);
  return parse(rows[0]);
}

async function list(limit = 20) {
  const [rows] = await db.query('SELECT * FROM product_videos ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map(parse);
}

async function findByStatus(status) {
  const [rows] = await db.query('SELECT * FROM product_videos WHERE status = ? ORDER BY id', [status]);
  return rows.map(parse);
}

async function update(id, fields) {
  await db.query('UPDATE product_videos SET ? WHERE id = ?', [serialize(fields), id]);
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM product_videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function creditsSince(date) {
  const [[row]] = await db.query('SELECT COALESCE(SUM(credits), 0) AS used FROM product_videos WHERE createdAt >= ?', [date]);
  return Number(row.used);
}

async function findExpiredFiles(before) {
  const [rows] = await db.query(
    'SELECT id, file_path FROM product_videos WHERE file_path IS NOT NULL AND completedAt < ?',
    [before]
  );
  return rows;
}

module.exports = { create, findById, findByToken, list, findByStatus, update, remove, creditsSince, findExpiredFiles };
