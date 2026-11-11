const { db } = require('../config/db');

// Toplu fiyat güncellemelerinin kaydı: her ürünün eski ve yeni fiyatı saklanır, böylece işlem geri alınabilir.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS shopier_batches (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(200) NOT NULL,
    revert_of INT UNSIGNED NULL,
    status ENUM('running','done','aborted') NOT NULL DEFAULT 'running',
    note VARCHAR(500) NULL,
    created_at DATETIME NOT NULL,
    finished_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS shopier_batch_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id INT UNSIGNED NOT NULL,
    product_id VARCHAR(40) NOT NULL,
    title VARCHAR(300) NOT NULL DEFAULT '',
    old_price DECIMAL(12,2) NULL,
    new_price DECIMAL(12,2) NOT NULL,
    old_discounted DECIMAL(12,2) NULL,
    new_discounted DECIMAL(12,2) NULL,
    variants_json TEXT NULL,
    status ENUM('pending','ok','skipped','error') NOT NULL DEFAULT 'pending',
    error VARCHAR(500) NULL,
    INDEX idx_batch (batch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

let ready = null;
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      for (const sql of TABLES) await db.query(sql);
      // İşlem bellekte yürür; süreç açılışında "running" kalan kayıt, sunucu yeniden başladığı için yarıda kalmıştır
      await db.query(
        "UPDATE shopier_batches SET status = 'aborted', note = 'Sunucu yeniden başladı, işlem yarıda kaldı.', finished_at = ? WHERE status = 'running'",
        [new Date()]
      );
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseVariants(json) {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

const mapItem = (r) => ({
  id: r.id,
  productId: r.product_id,
  title: r.title,
  oldPrice: num(r.old_price),
  newPrice: num(r.new_price),
  oldDiscounted: num(r.old_discounted),
  newDiscounted: num(r.new_discounted),
  variants: parseVariants(r.variants_json),
  status: r.status,
  error: r.error,
});

const mapBatch = (r) => ({
  id: r.id,
  label: r.label,
  revertOf: r.revert_of,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  total: Number(r.total || 0),
  ok: Number(r.ok || 0),
  skipped: Number(r.skipped || 0),
  failed: Number(r.failed || 0),
});

const BATCH_SELECT = `SELECT b.*, COUNT(i.id) AS total, SUM(i.status = 'ok') AS ok, SUM(i.status = 'skipped') AS skipped, SUM(i.status = 'error') AS failed
  FROM shopier_batches b LEFT JOIN shopier_batch_items i ON i.batch_id = b.id`;

module.exports = {
  ensureReady,

  // items: [{ productId, title, newPrice, newDiscounted, variants: [{ key, title, new }] }]
  async create(label, items, revertOf = null) {
    await ensureReady();
    const [result] = await db.query('INSERT INTO shopier_batches (label, revert_of, created_at) VALUES (?, ?, ?)', [label.slice(0, 200), revertOf, new Date()]);
    const rows = items.map((it) => [
      result.insertId, it.productId, String(it.title || '').slice(0, 300), it.newPrice, it.newDiscounted ?? null,
      it.variants?.length ? JSON.stringify(it.variants) : null,
    ]);
    await db.query('INSERT INTO shopier_batch_items (batch_id, product_id, title, new_price, new_discounted, variants_json) VALUES ?', [rows]);
    return result.insertId;
  },

  async list(limit = 20) {
    await ensureReady();
    const [rows] = await db.query(`${BATCH_SELECT} GROUP BY b.id ORDER BY b.id DESC LIMIT ?`, [limit]);
    return rows.map(mapBatch);
  },

  async get(id) {
    await ensureReady();
    const [rows] = await db.query(`${BATCH_SELECT} WHERE b.id = ? GROUP BY b.id`, [id]);
    if (!rows[0]) return null;
    const [items] = await db.query('SELECT * FROM shopier_batch_items WHERE batch_id = ? ORDER BY id', [id]);
    return { ...mapBatch(rows[0]), items: items.map(mapItem) };
  },

  async finishItem(id, { status, error = null, oldPrice = null, oldDiscounted = null, variants = null }) {
    await db.query(
      'UPDATE shopier_batch_items SET status = ?, error = ?, old_price = ?, old_discounted = ?, variants_json = COALESCE(?, variants_json) WHERE id = ?',
      [status, error ? String(error).slice(0, 500) : null, oldPrice, oldDiscounted, variants ? JSON.stringify(variants) : null, id]
    );
  },

  async finish(id, status, note = null) {
    await db.query('UPDATE shopier_batches SET status = ?, note = ?, finished_at = ? WHERE id = ?', [status, note, new Date(), id]);
  },
};
