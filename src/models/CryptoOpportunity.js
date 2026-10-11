const { db } = require('../config/db');

// Zaman Node'dan verilir: DB ile uygulama farklı saat diliminde olabilir (NOW() kayardı)
async function listActive() {
  const [rows] = await db.query('SELECT * FROM crypto_opportunities WHERE expires_at > ? ORDER BY found_at DESC', [new Date()]);
  return rows;
}

// Aynı coin tekrar bulunursa sebebi ve süresi tazelenir
async function upsert({ symbol, reason, expiresAt }) {
  await db.query(
    'INSERT INTO crypto_opportunities (symbol, reason, found_at, expires_at) VALUES (?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE reason = VALUES(reason), found_at = VALUES(found_at), expires_at = VALUES(expires_at)',
    [symbol, String(reason).slice(0, 500), new Date(), expiresAt]
  );
}

async function purgeExpired() {
  await db.query('DELETE FROM crypto_opportunities WHERE expires_at <= ?', [new Date()]);
}

module.exports = { listActive, upsert, purgeExpired };
