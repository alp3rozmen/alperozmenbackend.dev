const axios = require('axios');
const Setting = require('../../models/Setting');

const BASE_URL = 'https://api.kie.ai/api/v1';

async function api() {
  const key = await Setting.get('kie_api_key');
  if (!key) throw new Error('kie.ai API anahtarı tanımlı değil (Ayarlar sayfası)');
  return axios.create({ baseURL: BASE_URL, timeout: 30_000, headers: { Authorization: `Bearer ${key}` } });
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

module.exports = { createTask, getTask };
