const axios = require('axios');
const Setting = require('../../models/Setting');

// Telegraf'ı launch etmeden doğrudan Bot API'ye yazar; diğer botlarla polling çakışması olmaz.
async function sendMessage(text) {
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
  });
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

module.exports = { sendMessage, listChats };
