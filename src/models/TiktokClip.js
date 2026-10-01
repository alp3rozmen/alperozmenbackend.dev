const { db } = require('../config/db');

async function create(clip) {
  const [result] = await db.query('INSERT INTO tiktok_clips SET ?', [clip]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tiktok_clips WHERE id = ?', [id]);
  return rows[0] || null;
}

async function listByIdea(ideaId, ideaIndex) {
  const params = [ideaId];
  let where = 'idea_id = ?';
  if (ideaIndex !== undefined) {
    where += ' AND idea_index = ?';
    params.push(ideaIndex);
  }
  const [rows] = await db.query(`SELECT * FROM tiktok_clips WHERE ${where} ORDER BY sort_order, id`, params);
  return rows;
}

async function nextSortOrder(ideaId, ideaIndex) {
  const [[row]] = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tiktok_clips WHERE idea_id = ? AND idea_index = ?',
    [ideaId, ideaIndex]
  );
  return Number(row.next);
}

async function update(id, fields) {
  await db.query('UPDATE tiktok_clips SET ? WHERE id = ?', [fields, id]);
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM tiktok_clips WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function findOlderThan(date) {
  const [rows] = await db.query('SELECT * FROM tiktok_clips WHERE createdAt < ?', [date]);
  return rows;
}

module.exports = { create, findById, listByIdea, nextSortOrder, update, remove, findOlderThan };
