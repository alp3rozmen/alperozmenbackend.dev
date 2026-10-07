const { db } = require('../config/db');

// Panelden düzenlenebilen ayarlar. `env`: DB'de değer yoksa kullanılacak ortam değişkenleri.
// `default`: ne DB'de ne .env'de değer yoksa kullanılır. `secret`: panelde tam değeri gösterilmez.
const DEFINITIONS = {
  crypto_tg_bot_token: { env: ['CRYPTO_TG_BOT_TOKEN', 'BOT_TOKEN_CRYPTO'], secret: true },
  crypto_tg_chat_id: { env: ['CRYPTO_TG_CHAT_ID'], secret: false },
  crypto_cron_key: { env: ['CRYPTO_CRON_KEY'], secret: true },
  gemini_api_key: { env: ['GEMINI_API'], secret: true },
  gemini_text_model: { env: [], secret: false, default: 'gemini-2.5-flash' },
  kie_api_key: { env: ['KIE_API_KEY'], secret: true },
  kie_video_model: { env: [], secret: false, default: 'grok-imagine/text-to-video' },
  kie_monthly_credit_limit: { env: [], secret: false, default: '1000' },
  brand_name: { env: [], secret: false, default: 'ALREY 3D' },
  // Instagram resmi API (Instagram Login ile Creator/Business hesap); otomatik Reels paylaşımı için
  ig_user_id: { env: ['IG_USER_ID'], secret: false },
  ig_access_token: { env: ['IG_ACCESS_TOKEN'], secret: true },
  // Instagram videoyu bu adresten indirir: Application URL (+ BASE_PATH)
  public_base_url: { env: ['PUBLIC_BASE_URL'], secret: false, default: 'https://alperozmen.dev/admin' },
};

// Telegram her mesajda ayar okuduğu için kısa süreli önbellek
let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;

async function loadAll() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const [rows] = await db.query('SELECT `key`, `value` FROM app_settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

function envValue(key) {
  for (const name of DEFINITIONS[key].env) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

// DB değeri, yoksa .env değeri
async function get(key) {
  let stored = null;
  try {
    stored = (await loadAll())[key];
  } catch (err) {
    console.error('Ayarlar okunamadı:', err.message);
  }
  return stored || envValue(key) || DEFINITIONS[key].default || null;
}

// Panel için: gizli değerlerin sadece son 4 karakteri döner
async function listForPanel() {
  const stored = await loadAll();
  return Object.entries(DEFINITIONS).map(([key, def]) => {
    const value = stored[key] || null;
    return {
      key,
      secret: def.secret,
      value: def.secret ? null : value,
      hint: def.secret && value ? '••••' + value.slice(-4) : null,
      isSet: !!value,
      fromEnv: !value && !!envValue(key),
      default: def.default || null,
    };
  });
}

// Tanımsız anahtarlar yok sayılır; boş string ayarı siler (.env'ye geri döner)
async function setMany(values) {
  for (const [key, raw] of Object.entries(values)) {
    if (!DEFINITIONS[key] || raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value === '') {
      await db.query('DELETE FROM app_settings WHERE `key` = ?', [key]);
    } else {
      await db.query(
        'INSERT INTO app_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, value]
      );
    }
  }
  cache = null;
}

module.exports = { get, listForPanel, setMany, DEFINITIONS };
