const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Setting = require('../models/Setting');

// Telegraf'ı launch etmeden doğrudan Bot API'ye yazar; diğer botlarla polling çakışması olmaz.
// silent: bildirim sesi çıkarmaz (sık gelen durum raporları için)
async function sendMessage(text, { silent = false } = {}) {
  const token = await Setting.get('crypto_tg_bot_token');
  const chatId = await Setting.get('crypto_tg_chat_id');
  if (!token || !chatId) {
    console.warn('Telegram ayarı eksik (bot token / chat id), mesaj atlanıyor.');
    return false;
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: silent,
  });
  return true;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bot API dosya yükleme sınırı 50MB; caption en fazla 1024 karakter
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

async function sendVideo(filePath, caption) {
  const token = await Setting.get('crypto_tg_bot_token');
  const chatId = await Setting.get('crypto_tg_chat_id');
  if (!token || !chatId) {
    console.warn('Telegram ayarı eksik (bot token / chat id), video atlanıyor.');
    return false;
  }
  const { size } = await fs.promises.stat(filePath);
  if (size > MAX_VIDEO_BYTES) {
    const note = `\n\n⚠️ Video Telegram sınırından büyük (${(size / 1048576).toFixed(0)}MB), panelden indir.`;
    return sendMessage(escapeHtml(caption.slice(0, 3500)) + note);
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  // Düz metin: kırpma HTML etiketini bölerse Telegram mesajı reddeder
  form.append('caption', caption.slice(0, 1024));
  form.append('supports_streaming', 'true');
  form.append('video', await fs.openAsBlob(filePath, { type: 'video/mp4' }), path.basename(filePath));
  await axios.post(`https://api.telegram.org/bot${token}/sendVideo`, form, { maxBodyLength: Infinity });
  return true;
}

// Bota mesaj atan sohbetleri listeler; chat id'yi bulmak için.
async function listChats() {
  const token = await Setting.get('crypto_tg_bot_token');
  if (!token) throw new Error('Telegram bot token tanımlı değil');
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
  const chats = new Map();
  for (const u of data.result) {
    const chat = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title || chat.username || chat.first_name });
  }
  return [...chats.values()];
}

module.exports = { sendMessage, sendVideo, listChats, escapeHtml };
