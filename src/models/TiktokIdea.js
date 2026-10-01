const { db } = require('../config/db');

const parse = (row) => row && { ...row, ideas: JSON.parse(row.ideas) };

async function create({ productName, notes, research, ideas }) {
  const [result] = await db.query(
    'INSERT INTO tiktok_ideas (product_name, notes, research, ideas) VALUES (?, ?, ?, ?)',
    [productName, notes || null, research || null, JSON.stringify(ideas)]
  );
  return result.insertId;
}

async function list(limit = 50) {
  const [rows] = await db.query(
    'SELECT id, product_name, createdAt FROM tiktok_ideas ORDER BY createdAt DESC LIMIT ?',
    [limit]
  );
  return rows;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tiktok_ideas WHERE id = ?', [id]);
  return parse(rows[0]);
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM tiktok_ideas WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = { create, list, findById, remove };
