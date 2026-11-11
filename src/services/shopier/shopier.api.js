const axios = require('axios');
const Setting = require('../../models/Setting');

// Shopier REST API (developer.shopier.com). Kimlik: kişisel erişim tokenı (PAT) ya da uygulamanın OAuth 2.0 tokenı.
// OAuth tokenı 3 gün geçerli; refresh token tek kullanımlık olduğu için her yenilemede yenisi kaydedilir.
const API_URL = 'https://api.shopier.com/v1';
const OAUTH_URL = 'https://api.shopier.com:8443/v1/oauth2';
const AUTHORIZE_URL = 'https://shopier.com/m/login.php';
const TIMEOUT_MS = 30_000;
const REFRESH_EARLY_MS = 10 * 60_000;
const PAGE_LIMIT = 50; // API'nin izin verdiği en büyük sayfa
const MAX_PAGES = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Shopier hata gövdesi: { error, message }
function describe(err) {
  const body = err.response?.data;
  const detail = (body && typeof body === 'object' && (body.message || body.error_description || body.error)) || err.message;
  return err.response ? `Shopier ${err.response.status}: ${detail}` : `Shopier'e ulaşılamadı: ${detail}`;
}

async function readOauth() {
  const raw = await Setting.get('shopier_oauth');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveOauth(data) {
  await Setting.setMany({
    shopier_oauth: JSON.stringify({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 259200) * 1000,
    }),
  }, { internal: true });
}

async function credentials() {
  const [clientId, clientSecret] = await Promise.all([Setting.get('shopier_client_id'), Setting.get('shopier_client_secret')]);
  if (!clientId || !clientSecret) throw apiError('Shopier client id / client secret girilmemiş (Ayarlar).', 400);
  return { clientId, clientSecret };
}

async function tokenRequest(fields) {
  const { clientId, clientSecret } = await credentials();
  try {
    const { data } = await axios.post(
      `${OAUTH_URL}/token`,
      new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_MS }
    );
    if (!data?.access_token) throw new Error('cevapta access_token yok');
    await saveOauth(data);
    return data.access_token;
  } catch (err) {
    throw apiError(describe(err), err.response?.status === 400 || err.response?.status === 401 ? 401 : 502);
  }
}

async function authorizeUrl(redirectUri, state) {
  const { clientId } = await credentials();
  return `${AUTHORIZE_URL}?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state })}`;
}

const exchangeCode = (code) => tokenRequest({ grant_type: 'authorization_code', code });

// Aynı anda gelen istekler refresh token'ı iki kez kullanmasın (ikincisi geçersiz olur)
let refreshing = null;
function refresh(refreshToken) {
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }).finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function accessToken({ forceRefresh = false } = {}) {
  const pat = await Setting.get('shopier_pat');
  if (pat) return pat;
  const oauth = await readOauth();
  if (!oauth?.accessToken) throw apiError('Shopier hesabı bağlı değil.', 401);
  if (!forceRefresh && oauth.expiresAt - REFRESH_EARLY_MS > Date.now()) return oauth.accessToken;
  if (!oauth.refreshToken) throw apiError('Shopier oturumu sona ermiş, yeniden bağlan.', 401);
  return refresh(oauth.refreshToken);
}

async function status() {
  const [clientId, clientSecret, pat, oauth] = await Promise.all([
    Setting.get('shopier_client_id'), Setting.get('shopier_client_secret'), Setting.get('shopier_pat'), readOauth(),
  ]);
  return {
    configured: !!(clientId && clientSecret),
    connected: !!(pat || oauth?.accessToken),
    mode: pat ? 'pat' : oauth?.accessToken ? 'oauth' : null,
    expiresAt: !pat && oauth?.expiresAt ? new Date(oauth.expiresAt).toISOString() : null,
  };
}

async function disconnect() {
  const oauth = await readOauth();
  if (oauth?.refreshToken) {
    // Shopier tarafında da iptal etmeyi dene; olmazsa yerel token yine silinir
    try {
      const { clientId, clientSecret } = await credentials();
      await axios.post(
        `${OAUTH_URL}/revoke`,
        new URLSearchParams({ token: oauth.refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_MS }
      );
    } catch (err) {
      console.warn('Shopier token iptal edilemedi:', describe(err));
    }
  }
  await Setting.setMany({ shopier_oauth: '' }, { internal: true });
}

// 429'da Retry-After kadar bekler, süresi dolmuş tokenı bir kez yeniler, geçici sunucu hatasını bir kez tekrar dener
async function request(method, path, { params, data } = {}) {
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken();
    try {
      return await axios({ method, url: `${API_URL}${path}`, params, data, headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS });
    } catch (err) {
      const code = err.response?.status;
      if (code === 429 && attempt <= 4) {
        await sleep(Math.min(Number(err.response.headers['retry-after']) || 5, 60) * 1000);
        continue;
      }
      if (code === 401 && !refreshed && !(await Setting.get('shopier_pat'))) {
        refreshed = true;
        await accessToken({ forceRefresh: true });
        continue;
      }
      if ((!code || code >= 500) && attempt === 1) {
        await sleep(2000);
        continue;
      }
      throw apiError(describe(err), code === 401 ? 401 : 502);
    }
  }
}

async function listProducts() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request('get', '/products', { params: { limit: PAGE_LIMIT, page, sort: 'dateDesc' } });
    const items = Array.isArray(res.data) ? res.data : [];
    all.push(...items);
    const totalPages = Number(res.headers['shopier-pagination-total-pages']);
    if (items.length < PAGE_LIMIT || (totalPages && page >= totalPages)) break;
  }
  return all;
}

const getProduct = async (id) => (await request('get', `/products/${encodeURIComponent(id)}`)).data;
const updateProduct = async (id, body) => (await request('put', `/products/${encodeURIComponent(id)}`, { data: body })).data;

module.exports = { authorizeUrl, exchangeCode, status, disconnect, listProducts, getProduct, updateProduct };
