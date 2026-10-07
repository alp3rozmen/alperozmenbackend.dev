const axios = require('axios');
const Setting = require('../../models/Setting');

const BASE_URL = 'https://api.kie.ai/api/v1';
const UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-base64-upload';

async function apiKey() {
  const key = await Setting.get('kie_api_key');
  if (!key) throw new Error('kie.ai API anahtarı tanımlı değil (Ayarlar sayfası)');
  return key;
}

async function api() {
  return axios.create({ baseURL: BASE_URL, timeout: 30_000, headers: { Authorization: `Bearer ${await apiKey()}` } });
}

// Fotoğraftan video modelleri dış URL istiyor; görsel kie'nin deposuna yüklenir (ücretsiz, 24 saat tutulur)
async function uploadImage(buffer, mimetype, fileName) {
  const { data } = await axios.post(UPLOAD_URL, {
    base64Data: `data:${mimetype};base64,${buffer.toString('base64')}`,
    uploadPath: 'product-photos',
    fileName,
  }, { headers: { Authorization: `Bearer ${await apiKey()}` }, timeout: 60_000, maxBodyLength: Infinity });
  if (!data.success || !data.data?.downloadUrl) throw new Error(`kie.ai görsel yükleme: ${data.msg || 'bilinmeyen hata'}`);
  return data.data.downloadUrl;
}

// kie HTTP 200 dönse bile gövdedeki `code` hata olabilir
function unwrap(data) {
  if (data.code !== 200) throw new Error(`kie.ai: ${data.msg || 'bilinmeyen hata'} (${data.code})`);
  return data.data;
}

async function createTask(model, input) {
  const { data } = await (await api()).post('/jobs/createTask', { model, input });
  return unwrap(data).taskId;
}

async function getTask(taskId) {
  const { data } = await (await api()).get('/jobs/recordInfo', { params: { taskId } });
  const task = unwrap(data);
  let urls = [];
  if (task.resultJson) {
    try {
      urls = JSON.parse(task.resultJson).resultUrls || [];
    } catch {
      urls = [];
    }
  }
  return {
    state: task.state,
    urls,
    credits: task.creditsConsumed ?? null,
    failMsg: task.failMsg || task.failCode || null,
  };
}

module.exports = { createTask, getTask, uploadImage };
