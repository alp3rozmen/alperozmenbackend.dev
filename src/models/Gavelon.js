// Gavelon oyunu içeriği: evrenler, karakterler, bağlar, masalar, senaryolar ve oyun ayarı.
// Admin panelden düzenlenir; geçerliyse statik data.json olarak yayınlanır (oyun uygulaması ve
// oyun sunucusu bunu okur). /admin altı bot doğrulamasına takıldığı için yayın statik klasöre yapılır.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../config/db');
const log = require('../services/logger');
const { checkEntity, checkConfig, validateGameData } = require('../services/gavelon/validate');

// API alanı -> kolon. json: kolonda JSON metni olarak tutulanlar, bool: 0/1 olanlar.
const ENTITIES = {
  universes: {
    table: 'gavelon_universes',
    cols: { id: 'id', name: 'name', color: 'color' },
    json: [],
    bool: [],
    order: 'name',
  },
  characters: {
    table: 'gavelon_characters',
    cols: { id: 'id', name: 'name', universe: 'universe', category: 'category', league: 'league', tags: 'tags_json', image: 'image', hint: 'hint', active: 'active' },
    json: ['tags'],
    bool: ['active'],
    order: 'universe, name',
  },
  bonds: {
    table: 'gavelon_bonds',
    cols: { id: 'id', name: 'name', description: 'description', condition: 'condition_json', bonus: 'bonus', active: 'active' },
    json: ['condition'],
    bool: ['active'],
    order: 'name',
  },
  tables: {
    table: 'gavelon_tables',
    cols: { id: 'id', name: 'name', category: 'category', description: 'description', filter: 'filter_json', active: 'active' },
    json: ['filter'],
    bool: ['active'],
    order: 'name',
  },
  scenarios: {
    table: 'gavelon_scenarios',
    cols: { id: 'id', name: 'name', description: 'description', modifiers: 'modifiers_json', active: 'active' },
    json: ['modifiers'],
    bool: ['active'],
    order: 'name',
  },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gavelon_universes (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    color CHAR(7) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS gavelon_characters (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    universe VARCHAR(40) NOT NULL,
    category VARCHAR(40) NOT NULL,
    league VARCHAR(10) NOT NULL,
    tags_json TEXT NOT NULL,
    image VARCHAR(500) NULL,
    hint VARCHAR(500) NOT NULL DEFAULT '',
    active TINYINT(1) NOT NULL DEFAULT 1,
    INDEX idx_universe (universe)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS gavelon_bonds (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    condition_json TEXT NOT NULL,
    bonus INT NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS gavelon_tables (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT '',
    description VARCHAR(500) NOT NULL DEFAULT '',
    filter_json TEXT NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS gavelon_scenarios (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    modifiers_json TEXT NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS gavelon_settings (
    \`key\` VARCHAR(40) PRIMARY KEY,
    value TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const SEED_FILE = path.join(__dirname, '..', 'data', 'gavelon.seed.json');
const PUBLISH_DIR = process.env.GAVELON_PUBLISH_DIR || path.join(__dirname, '..', '..', 'storage', 'gavelon');
const IMG_DIR = path.join(PUBLISH_DIR, 'img');
const DATA_FILE = path.join(PUBLISH_DIR, 'data.json');

let ready = null;

const toRow = (entity, data) => {
  const e = ENTITIES[entity];
  const row = {};
  for (const [apiKey, col] of Object.entries(e.cols)) {
    if (data[apiKey] === undefined) continue;
    let v = data[apiKey];
    if (e.json.includes(apiKey)) v = JSON.stringify(v);
    else if (e.bool.includes(apiKey)) v = v ? 1 : 0;
    else if (apiKey === 'image' && v === '') v = null;
    row[col] = v;
  }
  return row;
};

const fromRow = (entity, row) => {
  const e = ENTITIES[entity];
  const out = {};
  for (const [apiKey, col] of Object.entries(e.cols)) {
    let v = row[col];
    if (e.json.includes(apiKey)) v = JSON.parse(v);
    else if (e.bool.includes(apiKey)) v = !!v;
    out[apiKey] = v;
  }
  return out;
};

async function insertRow(entity, data, ignore = false) {
  const row = toRow(entity, data);
  const cols = Object.keys(row);
  await db.query(
    `INSERT ${ignore ? 'IGNORE ' : ''}INTO \`${ENTITIES[entity].table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c])
  );
}

// Tablolar yoksa oluşturulur; hiç içerik yoksa uygulamayla gelen başlangıç verisi içeri aktarılır.
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      for (const sql of SCHEMA) await db.query(sql);
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM gavelon_characters');
      if (n === 0 && fs.existsSync(SEED_FILE)) {
        const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
        for (const entity of Object.keys(ENTITIES)) {
          for (const item of seed[entity] || []) await insertRow(entity, { ...item, active: true }, true);
        }
        await db.query('INSERT IGNORE INTO gavelon_settings (`key`, value) VALUES (?, ?)', ['config', JSON.stringify(seed.config)]);
        log.info('gavelon', 'Başlangıç içeriği içeri aktarıldı');
      }
    })().catch((err) => {
      ready = null; // sonraki istekte tekrar dene
      throw err;
    });
  }
  return ready;
}

const Gavelon = {
  entities: () => Object.keys(ENTITIES),
  has: (entity) => Object.prototype.hasOwnProperty.call(ENTITIES, entity),

  async list(entity) {
    await ensureReady();
    const [rows] = await db.query(`SELECT * FROM \`${ENTITIES[entity].table}\` ORDER BY ${ENTITIES[entity].order}`);
    return rows.map((r) => fromRow(entity, r));
  },

  async find(entity, id) {
    await ensureReady();
    const [rows] = await db.query(`SELECT * FROM \`${ENTITIES[entity].table}\` WHERE id = ?`, [id]);
    return rows[0] ? fromRow(entity, rows[0]) : null;
  },

  async create(entity, data) {
    await ensureReady();
    const item = { active: true, ...data };
    const error = checkEntity(entity, item);
    if (error) return { error };
    if (await Gavelon.find(entity, item.id)) return { error: 'Bu id zaten kullanılıyor.' };
    await insertRow(entity, item);
    return { item: await Gavelon.find(entity, item.id) };
  },

  async update(entity, id, data) {
    await ensureReady();
    const current = await Gavelon.find(entity, id);
    if (!current) return { notFound: true };
    const merged = { ...current, ...data, id }; // id değiştirilemez (başka kayıtlar ona bağlı)
    const error = checkEntity(entity, merged);
    if (error) return { error };
    const row = toRow(entity, merged);
    delete row.id;
    const cols = Object.keys(row);
    await db.query(`UPDATE \`${ENTITIES[entity].table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => row[c]), id]);
    return { item: await Gavelon.find(entity, id) };
  },

  async remove(entity, id) {
    await ensureReady();
    const [result] = await db.query(`DELETE FROM \`${ENTITIES[entity].table}\` WHERE id = ?`, [id]);
    return result.affectedRows > 0;
  },

  async getConfig() {
    await ensureReady();
    const [rows] = await db.query('SELECT value FROM gavelon_settings WHERE `key` = ?', ['config']);
    return rows[0] ? JSON.parse(rows[0].value) : null;
  },

  async saveConfig(config) {
    await ensureReady();
    const error = checkConfig(config);
    if (error) return { error };
    await db.query('INSERT INTO gavelon_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', ['config', JSON.stringify(config)]);
    return { config };
  },

  // Oyunun okuyacağı veri: yalnızca aktif kayıtlar, "active" alanı olmadan.
  async buildData() {
    const strip = ({ active, ...rest }) => rest; // eslint-disable-line no-unused-vars
    const pick = async (entity) => (await Gavelon.list(entity)).filter((x) => x.active !== false).map(strip);
    const [universes, characters, bonds, tables, scenarios, config] = await Promise.all([
      Gavelon.list('universes'),
      pick('characters'),
      pick('bonds'),
      pick('tables'),
      pick('scenarios'),
      Gavelon.getConfig(),
    ]);
    if (!config) throw new Error('Oyun ayarı bulunamadı');
    const body = { universes, characters, bonds, tables, scenarios, config };
    const version = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
    return { version, ...body };
  },

  async validate() {
    const data = await Gavelon.buildData();
    return { data, errors: validateGameData(data) };
  },

  // Geçerliyse data.json'u (atomik olarak) yazar. Geçersizse eski dosya yerinde kalır.
  async publish() {
    const { data, errors } = await Gavelon.validate();
    if (errors.length) return { published: false, errors };
    fs.mkdirSync(PUBLISH_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, generatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, DATA_FILE);
    log.info('gavelon', `Yayınlandı (sürüm ${data.version}, ${data.characters.length} karakter)`);
    return { published: true, version: data.version, errors: [] };
  },

  // Yüklenen görseli kaydeder ve herkese açık adresini döndürür.
  saveImage(buffer, ext, publicBase) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, file), buffer);
    return `${publicBase.replace(/\/+$/, '')}/img/${file}`;
  },

  IMG_DIR,
  PUBLISH_DIR,
};

module.exports = Gavelon;
