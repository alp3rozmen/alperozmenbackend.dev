const { db } = require('../config/db');

async function create(video) {
  const [result] = await db.query('INSERT INTO tiktok_videos SET ?', [video]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tiktok_videos WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listByIdea(ideaId) {
  const [rows] = await db.query('SELECT * FROM tiktok_videos WHERE idea_id = ? ORDER BY createdAt DESC', [ideaId]);
  return rows;
}

async function findPending() {
  const [rows] = await db.query("SELECT * FROM tiktok_videos WHERE status = 'pending'");
  return rows;
}

async function update(id, fields) {
  await db.query('UPDATE tiktok_videos SET ? WHERE id = ?', [fields, id]);
}

// Sadece hâlâ pending olan satırı kapatır; aynı videoyu iki kez bitirip iki bildirim atmayı önler
async function finish(id, fields) {
  const [result] = await db.query("UPDATE tiktok_videos SET ? WHERE id = ? AND status = 'pending'", [fields, id]);
  return result.affectedRows === 1;
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM tiktok_videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function creditsSince(date) {
  const [[row]] = await db.query('SELECT COALESCE(SUM(credits), 0) AS used FROM tiktok_videos WHERE createdAt >= ?', [date]);
  return Number(row.used);
}

async function findExpiredFiles(before) {
  const [rows] = await db.query(
    "SELECT id, file_path FROM tiktok_videos WHERE status = 'success' AND file_path IS NOT NULL AND completedAt < ?",
    [before]
  );
  return rows;
}

module.exports = { create, findById, listByIdea, findPending, update, finish, remove, creditsSince, findExpiredFiles };
