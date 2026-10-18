const { db } = require('../config/db');

// Kalıcı sunucu günlüğü (MySQL app_logs). Paneldeki "Sunucu günlüğü" bölümü buradan okur.
// Günlük yazmak hiçbir zaman uygulamayı bozmamalı: tüm DB hataları yutulur.

const MAX_AGE_DAYS = 7;
const MAX_ROWS = 5000;
const DEDUPE_MS = 60_000;
// Panelden kapatılabilir (app_settings.server_log_enabled = '0'); kapalıyken sadece konsola (passenger.log) yazılır.
// Ayar Setting modeli yerine burada okunur: Setting'in hata mesajı tekrar günlüğe düşüp döngü kurmasın.
const ENABLED_KEY = 'server_log_enabled';
const ENABLED_CACHE_MS = 60_000;
let enabled = true;
let enabledAt = 0;

let ready = null;
let writes = 0;
let captured = false;
const recent = new Map(); // aynı uyarı/hata dakikada bir kez yazılsın (döngüdeki hata tabloyu doldurmasın)

function ensureTable() {
  if (!ready) {
    ready = db.query(
      `CREATE TABLE IF NOT EXISTS app_logs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        level ENUM('info','warn','error') NOT NULL,
        source VARCHAR(40) NOT NULL,
        message VARCHAR(1000) NOT NULL,
        createdAt DATETIME NOT NULL,
        INDEX idx_created (createdAt),
        INDEX idx_level (level, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((err) => {
      ready = null; // DB geçici kapalıysa sonraki yazımda tekrar denenir
      throw err;
    });
  }
  return ready;
}

async function prune() {
  await db.query('DELETE FROM app_logs WHERE createdAt < ?', [new Date(Date.now() - MAX_AGE_DAYS * 86_400_000)]);
  await db.query(
    'DELETE FROM app_logs WHERE id <= (SELECT id FROM (SELECT id FROM app_logs ORDER BY id DESC LIMIT 1 OFFSET ?) t)',
    [MAX_ROWS]
  );
}

async function isEnabled() {
  if (Date.now() - enabledAt < ENABLED_CACHE_MS) return enabled;
  enabledAt = Date.now();
  try {
    const [rows] = await db.query('SELECT `value` FROM app_settings WHERE `key` = ?', [ENABLED_KEY]);
    enabled = rows[0]?.value !== '0';
  } catch {
    // okunamazsa son bilinen değerle devam
  }
  return enabled;
}

async function setEnabled(value) {
  await db.query(
    'INSERT INTO app_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [ENABLED_KEY, value ? '1' : '0']
  );
  enabled = !!value;
  enabledAt = Date.now();
  return enabled;
}

// Tüm kayıtları siler; TRUNCATE diskteki yeri de geri verir (yetki yoksa DELETE)
async function clear() {
  await ensureTable();
  await db.query('TRUNCATE TABLE app_logs').catch(() => db.query('DELETE FROM app_logs'));
}

// force: günlük kapalı olsa da yazılır (sunucu çökmesi gibi nadir ve kritik kayıtlar)
async function write(level, source, message, { force = false } = {}) {
  try {
    if (!force && !(await isEnabled())) return;
    const text = String(message).replace(/\s+/g, ' ').slice(0, 1000);
    const now = Date.now();
    if (level !== 'info') {
      const key = `${level}|${source}|${text}`;
      if ((recent.get(key) || 0) > now - DEDUPE_MS) return;
      recent.set(key, now);
      if (recent.size > 500) recent.clear();
    }
    await ensureTable();
    await db.query('INSERT INTO app_logs (level, source, message, createdAt) VALUES (?, ?, ?, ?)', [level, source, text, new Date()]);
    if (++writes % 200 === 0) await prune();
  } catch {
    // DB yoksa sadece konsola düşer
  }
}

const info = (source, message) => { console.log(`[${source}] ${message}`); return write('info', source, message); };
const warn = (source, message) => { console.warn(`[${source}] ${message}`); return write('warn', source, message); };
const error = (source, message, opts) => { console.error(`[${source}] ${message}`); return write('error', source, message, opts); };

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack ? arg.stack.split('\n').slice(0, 3).join(' ') : arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg).slice(0, 300);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

// Uygulamadaki mevcut console.error / console.warn çağrıları da günlüğe düşsün (tek tek değiştirmeye gerek kalmasın).
// logger'ın kendi çağrıları write'ı doğrudan çağırdığı için burada çift kayıt olmaz.
function captureConsole() {
  if (captured) return;
  captured = true;
  for (const [method, level] of [['error', 'error'], ['warn', 'warn']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const text = args.map(formatArg).join(' ');
      if (/^\[[a-zçğıöşü]+\] /i.test(text)) return; // logger'ın kendi satırı (zaten yazıldı)
      write(level, 'konsol', text);
    };
  }
}

// level: 'error' (sadece hatalar) | 'warn' (uyarı + hata) | 'all'
async function read({ level = 'all', limit = 100 } = {}) {
  await ensureTable();
  const where = level === 'error' ? "WHERE level = 'error'" : level === 'warn' ? "WHERE level IN ('warn','error')" : '';
  const [rows] = await db.query(`SELECT id, level, source, message, createdAt FROM app_logs ${where} ORDER BY id DESC LIMIT ?`, [Math.min(Number(limit) || 100, 300)]);
  return rows;
}

module.exports = { info, warn, error, read, captureConsole, isEnabled, setEnabled, clear };
