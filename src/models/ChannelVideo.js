const { db } = require('../config/db');

const parse = (row) => row && { ...row, idea: row.idea ? JSON.parse(row.idea) : null };

function serialize(fields) {
  const out = { ...fields };
  if (out.idea !== undefined) out.idea = out.idea ? JSON.stringify(out.idea) : null;
  return out;
}

// Aynı hesap + saat için ikinci kayıt UNIQUE anahtara takılır; null döner
async function createForSlot(video) {
  try {
    const [result] = await db.query('INSERT INTO channel_videos SET ?', [serialize(video)]);
    return result.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null;
    throw err;
  }
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM channel_videos WHERE id = ?', [id]);
  return parse(rows[0]);
}

async function list({ accountId, limit = 30 }) {
  const where = accountId ? 'WHERE account_id = ?' : '';
  const params = accountId ? [accountId, limit] : [limit];
  const [rows] = await db.query(`SELECT * FROM channel_videos ${where} ORDER BY id DESC LIMIT ?`, params);
  return rows.map(parse);
}

async function findByStatus(status) {
  const [rows] = await db.query('SELECT * FROM channel_videos WHERE status = ? ORDER BY id', [status]);
  return rows.map(parse);
}

// Son fikirler (yeniden eskiye): tekrarı önlemek için başlık, format ve mekân Gemini'ye verilir
async function recentIdeas(accountId, limit = 30) {
  const [rows] = await db.query('SELECT idea FROM channel_videos WHERE account_id = ? AND idea IS NOT NULL ORDER BY id DESC LIMIT ?', [accountId, limit]);
  return rows.map((r) => JSON.parse(r.idea)).filter((idea) => idea?.title);
}

// Hikaye modunda yayınlanmış/yayına hazır bölümler (yeniden eskiye). Atlanan ve başarısız olanlar hikayeye sayılmaz.
// since: "yeni sezon başlat" anı; verilirse ondan önceki bölümler dahil edilmez.
async function storyIdeas(accountId, since = null, limit = 12) {
  const [rows] = await db.query(
    `SELECT idea FROM channel_videos WHERE account_id = ? AND idea IS NOT NULL
       AND status IN ('generating','rendering','ready','publishing','published')${since ? ' AND createdAt >= ?' : ''}
     ORDER BY id DESC LIMIT ?`,
    since ? [accountId, since, limit] : [accountId, limit]
  );
  return rows.map((r) => JSON.parse(r.idea)).filter((idea) => idea?.episode);
}

async function update(id, fields) {
  await db.query('UPDATE channel_videos SET ? WHERE id = ?', [serialize(fields), id]);
}

// Sadece beklenen durumdaysa günceller; Telegram'da çift tıklama aynı videoyu iki kez paylaşmasın
async function transition(id, from, fields) {
  const [result] = await db.query('UPDATE channel_videos SET ? WHERE id = ? AND status = ?', [serialize(fields), id, from]);
  return result.affectedRows === 1;
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM channel_videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

async function removeByAccount(accountId) {
  await db.query('DELETE FROM channel_videos WHERE account_id = ?', [accountId]);
}

async function creditsSince(date) {
  const [[row]] = await db.query('SELECT COALESCE(SUM(credits), 0) AS used FROM channel_videos WHERE createdAt >= ?', [date]);
  return Number(row.used);
}

async function findExpiredFiles(before) {
  const [rows] = await db.query('SELECT * FROM channel_videos WHERE file_path IS NOT NULL AND createdAt < ?', [before]);
  return rows.map(parse);
}

module.exports = {
  createForSlot, findById, list, findByStatus, recentIdeas, storyIdeas, update, transition, remove, removeByAccount, creditsSince, findExpiredFiles,
};
