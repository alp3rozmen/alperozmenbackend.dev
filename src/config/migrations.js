const { db } = require('./db');
const log = require('../services/logger');

// Tablo sunucuda oluşturulduktan SONRA schema.sql'e eklenen sütunlar. "CREATE TABLE IF NOT EXISTS" var olan
// tabloya sütun eklemediği için bunlar sunucuda eksik kalabiliyor (ör. crypto_trades.pending_cancel eksikken
// gerçek işlem takibi her dakika hata verdi). Açılışta kontrol edilir, eksikse eklenir.
// Var olan bir tabloya yeni sütun eklerken schema.sql'deki CREATE TABLE'a ek olarak buraya da yaz.
const COLUMNS = [
  ['product_videos', 'ig_account_id', 'INT UNSIGNED NULL'],
  ['ig_accounts', 'is_product', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['ig_accounts', 'comedy', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['ig_accounts', 'story', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['ig_accounts', 'story_cast', 'TEXT NULL'],
  ['ig_accounts', 'story_since', 'DATETIME NULL'],
  ['ig_accounts', 'story_premise', 'TEXT NULL'],
  ['crypto_trades', 'pending_text', 'VARCHAR(40) NULL'],
  ['crypto_trades', 'pending_at', 'DATETIME NULL'],
  ['crypto_trades', 'pending_cancel', 'VARCHAR(500) NULL'],
];

// "ADD COLUMN IF NOT EXISTS" sadece MariaDB'de var; information_schema ile kontrol MySQL'de de çalışır
async function run() {
  const [rows] = await db.query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const tables = new Set(rows.map((r) => r.t));
  const existing = new Set(rows.map((r) => `${r.t}.${r.c}`));
  for (const [table, column, definition] of COLUMNS) {
    // Tablo hiç yoksa dokunma; schema.sql ile tam haliyle oluşturulur
    if (!tables.has(table) || existing.has(`${table}.${column}`)) continue;
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    log.info('sunucu', `Veritabanı: eksik ${table}.${column} sütunu eklendi`);
  }
}

module.exports = { run };
