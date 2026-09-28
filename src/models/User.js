const { db } = require('../config/db');

module.exports = {
  findByUsername: async (username) => {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    return rows[0] || null;
  },

  findAll: async () => {
    const [rows] = await db.query('SELECT id, username, createdAt FROM users ORDER BY createdAt');
    return rows;
  },

  remove: async (id) => {
    const [result] = await db.query('DELETE FROM users WHERE id = ?', [id]);
    return result.affectedRows > 0;
  },

  create: async ({ username, password }) => {
    const [result] = await db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, password]);
    return result.insertId;
  }
};
