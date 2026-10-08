const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Setting = require('../models/Setting');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function botConfig() {
  return { token: await Setting.get('crypto_tg_bot_token'), chatId: await Setting.get('crypto_tg_chat_id') };
}

const apiUrl = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// buttons: [[{ text, data }]] satırlar halinde; data butona basılınca geri gelir (en fazla 64 byte)
function replyMarkup(buttons) {
  if (!buttons) return undefined;
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

// Telegraf'ı launch etmeden doğrudan Bot API'ye yazar; diğer botlarla polling çakışması olmaz.
// silent: bildirim sesi çıkarmaz (sık gelen durum raporları için)
async function sendMessage(text, { silent = false, buttons } = {}) {
  const { token, chatId } = await botConfig();
  if (!token || !chatId) {
    console.warn('Telegram ayarı eksik (bot token / chat id), mesaj atlanıyor.');
    return false;
  }
  const { data } = await axios.post(apiUrl(token, 'sendMessage'), {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: silent,
    reply_markup: replyMarkup(buttons),
  });
  return data.result.message_id;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bot API dosya yükleme sınırı 50MB; caption en fazla 1024 karakter
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Dönüş: gönderilen mesajın id'si (butonlu mesajı sonra güncellemek için) veya false
async function sendVideo(filePath, caption, { buttons } = {}) {
  const { token, chatId } = await botConfig();
  if (!token || !chatId) {
    console.warn('Telegram ayarı eksik (bot token / chat id), video atlanıyor.');
    return false;
  }
  const { size } = await fs.promises.stat(filePath);
  if (size > MAX_VIDEO_BYTES) {
    const note = `\n\n⚠️ Video Telegram sınırından büyük (${(size / 1048576).toFixed(0)}MB), panelden indir.`;
    return sendMessage(escapeHtml(caption.slice(0, 3500)) + note, { buttons });
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  // Düz metin: kırpma HTML etiketini bölerse Telegram mesajı reddeder
  form.append('caption', caption.slice(0, 1024));
  form.append('supports_streaming', 'true');
  if (buttons) form.append('reply_markup', JSON.stringify(replyMarkup(buttons)));
  form.append('video', await fs.openAsBlob(filePath, { type: 'video/mp4' }), path.basename(filePath));
  const { data } = await axios.post(apiUrl(token, 'sendVideo'), form, { maxBodyLength: Infinity });
  return data.result.message_id;
}

// Butonlu mesajın butonlarını kaldırır (karar verildikten sonra tekrar basılmasın)
async function clearButtons(messageId) {
  const { token, chatId } = await botConfig();
  if (!token || !chatId || !messageId) return;
  await axios.post(apiUrl(token, 'editMessageReplyMarkup'), { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    .catch(() => {}); // mesaj silinmiş/zaten butonsuz olabilir
}

// --- Buton tıklamalarını dinleme (getUpdates long polling) ---
// Webhook kullanılamaz: site bot korumasının arkasında, Telegram'ın POST'u doğrulama sayfasına takılır.

const handlers = new Map(); // callback_data öneki -> async (args, query) => cevap metni
const knownChats = new Map(); // chat id bulmak için (polling açıkken getUpdates'i başkası okuyamaz)
let polling = false;
let offset = 0;

// "cv:pub:12" gibi veriler ':' ile bölünür; ilk parça hangi işleyicinin çalışacağını seçer
function onCallback(prefix, handler) {
  handlers.set(prefix, handler);
  startPolling();
}

async function handleCallback(query, token, chatId) {
  const answer = (text) => axios.post(apiUrl(token, 'answerCallbackQuery'), { callback_query_id: query.id, text, show_alert: false })
    .catch(() => {});
  // Sadece ayarlı sohbetten gelen tıklamalar kabul edilir (bot başka yere eklenirse kimse tetikleyemesin)
  if (String(query.message?.chat?.id) !== String(chatId)) return answer('Yetkisiz');
  const [prefix, ...args] = String(query.data || '').split(':');
  const handler = handlers.get(prefix);
  if (!handler) return answer('Bilinmeyen işlem');
  try {
    await answer(await handler(args, query) || 'Tamam');
  } catch (err) {
    await answer(`Hata: ${String(err.message).slice(0, 150)}`);
  }
}

async function pollLoop() {
  for (;;) {
    const { token, chatId } = await botConfig().catch(() => ({}));
    if (!token) {
      await sleep(60_000);
      continue;
    }
    try {
      const { data } = await axios.get(apiUrl(token, 'getUpdates'), {
        params: { offset, timeout: 50, allowed_updates: JSON.stringify(['message', 'callback_query', 'my_chat_member', 'channel_post']) },
        timeout: 60_000,
      });
      for (const update of data.result) {
        offset = update.update_id + 1;
        const chat = (update.message || update.channel_post || update.my_chat_member || update.callback_query?.message || {}).chat;
        if (chat) knownChats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title || chat.username || chat.first_name });
        if (update.callback_query) handleCallback(update.callback_query, token, chatId);
      }
    } catch (err) {
      // 409: başka bir süreç aynı botla getUpdates yapıyor veya webhook tanımlı
      const conflict = err.response?.status === 409;
      if (conflict) console.error('Telegram güncellemeleri alınamıyor (409): aynı bot başka yerde dinleniyor ya da webhook tanımlı.');
      await sleep(conflict ? 60_000 : 5_000);
    }
  }
}

function startPolling() {
  if (polling) return;
  polling = true;
  pollLoop();
}

// Bota mesaj atan sohbetleri listeler; chat id'yi bulmak için.
async function listChats() {
  if (polling) return [...knownChats.values()];
  const token = await Setting.get('crypto_tg_bot_token');
  if (!token) throw new Error('Telegram bot token tanımlı değil');
  const { data } = await axios.get(apiUrl(token, 'getUpdates'));
  const chats = new Map();
  for (const u of data.result) {
    const chat = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title || chat.username || chat.first_name });
  }
  return [...chats.values()];
}

module.exports = { sendMessage, sendVideo, clearButtons, onCallback, listChats, escapeHtml };
