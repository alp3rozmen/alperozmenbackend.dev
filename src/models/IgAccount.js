const { db } = require('../config/db');

const parse = (row) => row && { ...row, active: !!row.active, niche_brief: row.niche_brief ? JSON.parse(row.niche_brief) : null };

// Panelde token gösterilmez
const view = (row) => {
  if (!row) return null;
  const { access_token: token, ...rest } = row;
  return { ...rest, token_hint: token ? '••••' + token.slice(-4) : null };
};

async function list() {
  const [rows] = await db.query('SELECT * FROM ig_accounts ORDER BY id');
  return rows.map(parse);
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM ig_accounts WHERE id = ?', [id]);
  return parse(rows[0]);
}

async function findByIgUserId(igUserId) {
  const [rows] = await db.query('SELECT * FROM ig_accounts WHERE ig_user_id = ?', [igUserId]);
  return parse(rows[0]);
}

function serialize(fields) {
  const out = { ...fields };
  if (out.niche_brief !== undefined) out.niche_brief = out.niche_brief ? JSON.stringify(out.niche_brief) : null;
  if (out.active !== undefined) out.active = out.active ? 1 : 0;
  return out;
}

async function create(account) {
  const [result] = await db.query('INSERT INTO ig_accounts SET ?', [serialize(account)]);
  return result.insertId;
}

async function update(id, fields) {
  await db.query('UPDATE ig_accounts SET ? WHERE id = ?', [serialize(fields), id]);
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM ig_accounts WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = { list, findById, findByIgUserId, create, update, remove, view };
