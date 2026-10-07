const axios = require('axios');
const Setting = require('../models/Setting');

// Instagram resmi API'si (Instagram Login). Resmi olmayan instagram-private-api'den farklı olarak hesap riski yok.
const BASE_URL = 'https://graph.instagram.com/v25.0';
const POLL_MS = 10_000;
const MAX_WAIT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function graphError(err) {
  return new Error(err.response?.data?.error?.message || err.message);
}

// Instagram videoyu videoUrl'den kendisi indirir; adres herkese açık olmalı
async function publishReel({ videoUrl, caption }) {
  const userId = await Setting.get('ig_user_id');
  const token = await Setting.get('ig_access_token');
  if (!userId || !token) throw new Error('Instagram kullanıcı id veya erişim token\'ı tanımlı değil (Ayarlar sayfası)');

  try {
    const { data: container } = await axios.post(`${BASE_URL}/${userId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: token },
      timeout: 30_000,
    });

    // Instagram videoyu indirip işler; hazır olana kadar bekle
    const started = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      const { data } = await axios.get(`${BASE_URL}/${container.id}`, {
        params: { fields: 'status_code,status', access_token: token },
        timeout: 30_000,
      });
      if (data.status_code === 'FINISHED') break;
      if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
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

module.exports = { publishReel };
