const { db } = require('../config/db');

async function list() {
  const [rows] = await db.query('SELECT id, name, createdAt FROM dolap_templates ORDER BY createdAt DESC');
  return rows;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM dolap_templates WHERE id = ?', [id]);
  return rows[0] || null;
}

async function create({ name, mime, image }) {
  const [result] = await db.query('INSERT INTO dolap_templates (name, mime, image) VALUES (?, ?, ?)', [name, mime, image]);
  return result.insertId;
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM dolap_templates WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = { list, findById, create, remove };
