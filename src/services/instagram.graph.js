const axios = require('axios');
const Setting = require('../models/Setting');

// Instagram resmi API'si (Instagram Login). Resmi olmayan instagram-private-api'den farklı olarak hesap riski yok.
const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.instagram.com/${API_VERSION}`;
const POLL_MS = 10_000;
const MAX_WAIT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function graphError(err) {
  const e = err.response?.data?.error || err.response?.data?.debug_info;
  return new Error(e?.error_user_msg || e?.message || err.message);
}

// Hesap verilmezse Ayarlar'daki eski tek hesap kullanılır
async function credentials(account) {
  if (account) return { userId: account.ig_user_id, token: account.access_token };
  return { userId: await Setting.get('ig_user_id'), token: await Setting.get('ig_access_token') };
}

// Instagram videoyu videoUrl'den kendisi indirir; adres herkese açık ve bot korumasız olmalı.
// (Doğrudan dosya yükleme / resumable upload sadece Facebook Login for Business uygulamalarında var.)
async function publishReel({ videoUrl, caption, account }) {
  const { userId, token } = await credentials(account);
  if (!userId || !token) throw new Error('Instagram hesabı seçilmedi veya token tanımlı değil (Instagram Kanalları sayfası)');

  try {
    const { data: container } = await axios.post(`${BASE_URL}/${userId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: token },
      timeout: 30_000,
    });

    // Instagram videoyu işler; hazır olana kadar bekle
    const started = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      const { data } = await axios.get(`${BASE_URL}/${container.id}`, {
        params: { fields: 'status_code,status', access_token: token },
        timeout: 30_000,
      });
      if (data.status_code === 'FINISHED') break;
      if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
        console.error('Instagram konteyner hatası:', JSON.stringify(data));
        throw new Error(`Instagram videoyu işleyemedi: ${data.status || data.status_code}`);
      }
      if (Date.now() - started > MAX_WAIT_MS) throw new Error('Instagram video işleme zaman aşımı (10 dk)');
    }

    const { data: published } = await axios.post(`${BASE_URL}/${userId}/media_publish`, null, {
      params: { creation_id: container.id, access_token: token },
      timeout: 30_000,
    });
    return published.id;
  } catch (err) {
    throw err.response ? graphError(err) : err;
  }
}

// Token'dan hesabın yayın id'si ve kullanıcı adı; hesap eklerken token'ın geçerli olduğunu da doğrular
async function getProfile(token) {
  try {
    const { data } = await axios.get(`${BASE_URL}/me`, { params: { fields: 'user_id,username', access_token: token }, timeout: 30_000 });
    return { igUserId: String(data.user_id), username: data.username };
  } catch (err) {
    throw err.response ? graphError(err) : err;
  }
}

// Uzun ömürlü token 60 gün geçerli; en az 24 saatlik token yenilenip süre tekrar 60 güne çıkar
async function refreshToken(token) {
  try {
    const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: token }, timeout: 30_000,
    });
    return data.access_token;
  } catch (err) {
    throw err.response ? graphError(err) : err;
  }
}

module.exports = { publishReel, getProfile, refreshToken };
