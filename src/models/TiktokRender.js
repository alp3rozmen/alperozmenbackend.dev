const { db } = require('../config/db');

async function create(render) {
  const [result] = await db.query('INSERT INTO tiktok_renders SET ?', [render]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tiktok_renders WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listByIdea(ideaId) {
  const [rows] = await db.query('SELECT * FROM tiktok_renders WHERE idea_id = ? ORDER BY createdAt DESC', [ideaId]);
  return rows;
}

async function findPending() {
  const [rows] = await db.query("SELECT * FROM tiktok_renders WHERE status = 'pending' ORDER BY id");
  return rows;
}

async function update(id, fields) {
  await db.query('UPDATE tiktok_renders SET ? WHERE id = ?', [fields, id]);
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM tiktok_renders WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function findExpiredFiles(before) {
  const [rows] = await db.query(
    "SELECT id, file_path FROM tiktok_renders WHERE status = 'success' AND file_path IS NOT NULL AND completedAt < ?",
    [before]
  );
  return rows;
}

module.exports = { create, findById, listByIdea, findPending, update, remove, findExpiredFiles };
