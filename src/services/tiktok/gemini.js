const { GoogleGenAI } = require('@google/genai');
const Setting = require('../../models/Setting');

async function client() {
  const apiKey = await Setting.get('gemini_api_key');
  if (!apiKey) throw new Error('Gemini API anahtarı tanımlı değil (Ayarlar sayfası)');
  return new GoogleGenAI({ apiKey });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini hata gövdesi JSON string olarak gelir; koddan anlaşılır mesaj üret
function friendlyError(err) {
  let info = {};
  try {
    info = JSON.parse(err.message).error || {};
  } catch {
    return err;
  }
  if (info.code === 429 && /limit: 0/.test(info.message)) {
    return new Error('Bu model ücretsiz planda kullanılamıyor; Ayarlar\'dan başka bir Gemini modeli seç.');
  }
  if (info.code === 429) return new Error('Gemini kota sınırına ulaşıldı, biraz sonra tekrar dene.');
  if (info.code === 503) return new Error('Gemini şu an yoğun, biraz sonra tekrar dene.');
  if (info.code === 404) return new Error('Model bulunamadı; Ayarlar\'daki model adını kontrol et.');
  return new Error(info.message || err.message);
}

// Geçici yoğunluk (503) hatalarında birkaç kez tekrar dener
async function generate(ai, request) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      const transient = /"code":\s*(503|500)/.test(err.message);
      if (!transient || attempt >= 3) throw friendlyError(err);
      await sleep(attempt * 3000);
    }
  }
}

const imagePart = (file) => ({ inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } });

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Fikrin kısa adı' },
          format: { type: 'string', description: 'Video formatı, örn. "AI hook + baskı timelapse + reveal"' },
          hookText: { type: 'string', description: 'İlk 2 saniyedeki ekran yazısı, Türkçe, merak uyandıran' },
          aiPrompt: {
            type: 'string',
            description: 'Hook klibi için İngilizce text-to-video prompt: dikey 9:16, sinematik, kamera hareketi, ışık, ürünün görünüşü',
          },
          shotList: { type: 'array', items: { type: 'string' }, description: 'Yazıcıyla çekilecek gerçek sahneler, sırayla' },
          onScreenTexts: { type: 'array', items: { type: 'string' }, description: 'Videoda sırayla çıkacak kısa Türkçe yazılar' },
          caption: { type: 'string', description: 'TikTok açıklaması, Türkçe, satışa yönlendiren çağrı içerir' },
          hashtags: { type: 'array', items: { type: 'string' }, description: '5-8 hashtag, # ile' },
          musicHint: { type: 'string', description: 'Uygun ses/müzik tarzı veya trend ses önerisi' },
        },
        required: ['title', 'format', 'hookText', 'aiPrompt', 'shotList', 'onScreenTexts', 'caption', 'hashtags', 'musicHint'],
      },
    },
  },
  required: ['ideas'],
};

// İki adım: (1) Google aramalı trend araştırması, (2) araştırmaya dayanan yapılandırılmış fikirler.
// Gemini, arama aracı ile JSON şemasını aynı istekte desteklemediği için ayrı çağrılar.
async function generateIdeas({ productName, notes, photos, count }) {
  const ai = await client();
  const model = await Setting.get('gemini_text_model');
  const brand = await Setting.get('brand_name');
  const product = `Ürün: ${productName}${notes ? `\nNot: ${notes}` : ''}`;

  const research = await generate(ai, {
    model,
    contents: `${product}\n\nBu ürün 3D yazıcıyla basılıp satılıyor (marka: ${brand}). ` +
      'Türkiye\'de TikTok\'ta şu an 3D baskı, gamer aksesuarı ve bu ürün türü için öne çıkan video formatlarını, ' +
      'trend sesleri ve en çok kullanılan / büyüyen hashtag\'leri araştır. Kısa maddeler halinde, Türkçe yaz.',
    config: { tools: [{ googleSearch: {} }] },
  });
  const researchText = research.text || '';

  const response = await generate(ai, {
    model,
    contents: [
      ...photos.map(imagePart),
      {
        text: `${product}\nMarka: ${brand}\n\nTrend araştırması:\n${researchText}\n\n` +
          `Bu ürün için ${count} farklı TikTok video fikri üret. Amaç: hesabı büyütmek ve ürün satışına yönlendirmek.\n` +
          'Kurallar:\n' +
          '- Her video, yapay zekayla üretilecek kısa bir hook klibiyle başlar; ardından gerçek baskı/ürün görüntüleri gelir.\n' +
          '- aiPrompt İngilizce olsun, ürünü fotoğraflardaki/nottaki gibi tarif etsin, logo veya marka adı yazdırmasın.\n' +
          '- Çekim listesi tek kişinin telefon ve 3D yazıcıyla çekebileceği sahnelerden oluşsun.\n' +
          '- Hashtag\'lerde araştırmadaki trend etiketlerle niş etiketleri karıştır.\n' +
          '- Fikirler birbirinden farklı formatlarda olsun.',
      },
    ],
    config: { responseMimeType: 'application/json', responseJsonSchema: IDEAS_SCHEMA },
  });

  return { research: researchText, ideas: JSON.parse(response.text).ideas };
}

module.exports = { generateIdeas };
