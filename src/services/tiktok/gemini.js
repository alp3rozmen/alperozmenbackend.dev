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

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    hookText: { type: 'string', description: 'İlk 2-3 saniyedeki ekran yazısı, Türkçe, en fazla 6 kelime, merak uyandıran' },
    scenes: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Sahnenin kısa Türkçe adı' },
          prompt: { type: 'string', description: 'İngilizce image-to-video prompt' },
          text: { type: 'string', description: 'Bu sahnede ekranda çıkacak Türkçe yazı, en fazla 6 kelime' },
        },
        required: ['title', 'prompt', 'text'],
      },
    },
    caption: { type: 'string', description: 'TikTok/Instagram açıklaması, Türkçe, 1-3 cümle, satın almaya yönlendiren çağrı içerir' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '5-8 hashtag, # ile' },
  },
  required: ['hookText', 'scenes', 'caption', 'hashtags'],
};

// Fotoğraftan otomatik ürün videosu için 3 sahnelik senaryo. Prompt'lar Grok image-to-video'ya gider;
// @image1 ön fotoğraf, varsa @image2 arka fotoğraftır.
async function generateProductPlan({ productName, notes, photos }) {
  const ai = await client();
  const model = await Setting.get('gemini_text_model');
  const brand = await Setting.get('brand_name');
  const hasBack = photos.length > 1;
  const refs = hasBack
    ? '@image1 is the FRONT of the product, @image2 is the BACK. When the back side is visible, it must match @image2.'
    : '@image1 is the product. Only one photo exists: keep unseen sides simple and consistent with the visible design.';

  const response = await generate(ai, {
    model,
    contents: [
      ...photos.map(imagePart),
      {
        text: `Ürün: ${productName}${notes ? `\nNot: ${notes}` : ''}\nMarka: ${brand} (3D yazıcıyla basılmış ürün)\n\n` +
          'Bu fotoğraflardan, satışa yönelik 18 saniyelik dikey (9:16) bir ürün tanıtım videosu için 3 sahne yaz. ' +
          'Her sahne 6 saniyelik ayrı bir AI videosu olarak üretilecek.\n' +
          'Sahne sırası:\n' +
          '1. Hero: temiz stüdyo zemininde ürün yavaşça döner (turntable) veya kamera etrafında yörüngede döner, tüm yüzlerini gösterir.\n' +
          '2. Detay: makro yakın çekim, yavaş kamera kayması; katman dokusu, kenarlar, renk.\n' +
          '3. Kullanım: ürün gerçek kullanım ortamında (fotoğrafa ve ürüne uygun: masa, oyun düzeni, raf vb.), doğal ışık.\n' +
          `prompt kuralları (İngilizce): her prompt "@image1 " ile başlasın. ${refs} ` +
          'The product must stay exactly like the photos: same shape, proportions, colors and details; do not add or change parts. ' +
          'No text, letters, logos or watermarks in the video. No people faces; hands only if natural. ' +
          'Describe camera movement, lighting and background clearly. Audio: soft ambient sound only, no speech, no voiceover, no singing.\n' +
          'Ekran yazıları ve açıklama Türkçe olsun; açıklamada satın almak için DM\'den yazmaya çağır.',
      },
    ],
    config: { responseMimeType: 'application/json', responseJsonSchema: PLAN_SCHEMA },
  });

  const plan = JSON.parse(response.text);
  if (!Array.isArray(plan.scenes) || plan.scenes.length < 3) throw new Error('Gemini 3 sahne üretmedi, tekrar dene.');
  plan.scenes = plan.scenes.slice(0, 3).map((scene) => ({
    ...scene,
    // Model bazen referansı unutuyor; ürünün fotoğraftan alınması için şart
    prompt: scene.prompt.trim().startsWith('@image1') ? scene.prompt.trim() : `@image1 ${scene.prompt.trim()}`,
  }));
  return plan;
}

// --- Niş kanalları (yüzsüz, viral AI video hesapları) ---

const NICHES_SCHEMA = {
  type: 'object',
  properties: {
    niches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nişin kısa Türkçe adı, örn. "Böceklerin gizli hayatı (komik)"' },
          description: { type: 'string', description: 'Videoların ne anlattığı, tonu ve görsel tarzı, 2-3 cümle' },
          why: { type: 'string', description: 'Neden büyüyor / neden takipçi kazandırıyor, araştırmaya dayanarak, 1-2 cümle' },
          examples: { type: 'array', items: { type: 'string' }, description: '4 örnek video fikri, birer cümle' },
          visualStyle: { type: 'string', description: 'İngilizce kısa görsel stil tarifi; tüm videoların prompt\'una eklenecek (tutarlı kanal görünümü)' },
          hashtags: { type: 'array', items: { type: 'string' }, description: 'Nişin temel hashtag\'leri, 6-10 adet, # ile' },
        },
        required: ['name', 'description', 'why', 'examples', 'visualStyle', 'hashtags'],
      },
    },
  },
  required: ['niches'],
};

// Google aramasıyla büyüyen yüzsüz AI video nişlerini araştırıp 5 öneri döner.
// hint: kullanıcının aklındaki yön (opsiyonel), örn. "komik hayvanlar"
async function suggestNiches({ hint } = {}) {
  const ai = await client();
  const model = await Setting.get('gemini_text_model');

  const research = await generate(ai, {
    model,
    contents: 'Instagram Reels ve TikTok\'ta son aylarda hızla takipçi kazanan, yüzü görünmeyen, tamamen yapay zekayla ' +
      'üretilmiş kısa video hesaplarını araştır (örn. konuşan/komik böcekler, minik insanlar, hayvan POV, ASMR, absürt mini hikâyeler). ' +
      'Hangi nişler büyüyor, videoları kaç saniye ve nasıl kurgulanıyor, neden paylaşılıyor, Türkiye\'de karşılığı ne? ' +
      (hint ? `Kullanıcının ilgilendiği yön: ${hint}. ` : '') +
      'Kısa maddeler halinde, Türkçe yaz.',
    config: { tools: [{ googleSearch: {} }] },
  });

  const response = await generate(ai, {
    model,
    contents: `Araştırma:\n${research.text || ''}\n\n` +
      'Bu araştırmaya dayanarak yeni açılacak bir Instagram hesabı için 5 farklı niş öner. Kısıtlar:\n' +
      '- Her video tek bir 6-10 saniyelik yapay zeka klibi olacak (text-to-video, sesli). Konuşma yerine ses efekti/müzikle anlaşılmalı.\n' +
      '- Gerçek kişi, marka, ünlü veya telifli karakter kullanılmayacak.\n' +
      '- Dil bağımsız ya da Türk izleyiciye uygun olsun; ekran yazısı ve açıklama Türkçe olacak.\n' +
      '- Seri hissi veren, tekrar tekrar üretilebilen bir format olsun.',
    config: { responseMimeType: 'application/json', responseJsonSchema: NICHES_SCHEMA },
  });

  return { research: research.text || '', niches: JSON.parse(response.text).niches };
}

const CHANNEL_IDEA_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Fikrin kısa Türkçe adı (tekrarları önlemek için kaydedilir)' },
    prompt: {
      type: 'string',
      description: 'İngilizce text-to-video prompt: dikey 9:16, tek kesintisiz çekim, başta güçlü bir an, kamera, ışık, ses efektleri',
    },
    hookText: { type: 'string', description: 'Videonun ilk 2-3 saniyesindeki Türkçe ekran yazısı, en fazla 6 kelime' },
    caption: { type: 'string', description: 'Instagram açıklaması, Türkçe, 1-2 kısa cümle + takip etmeye çağrı' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '8-12 hashtag, # ile; nişin temel etiketleri + bu videoya özel' },
  },
  required: ['title', 'prompt', 'hookText', 'caption', 'hashtags'],
};

// Bir kanal için yeni video fikri; son başlıklar verilerek tekrar engellenir
async function generateChannelIdea({ niche, brief, seconds, recentTitles }) {
  const ai = await client();
  const model = await Setting.get('gemini_text_model');
  const style = brief?.visualStyle ? `Kanalın sabit görsel stili (prompt'a dahil et): ${brief.visualStyle}\n` : '';

  const response = await generate(ai, {
    model,
    contents: `Instagram kanalı nişi: ${niche}\n` +
      (brief?.description ? `Niş tarifi: ${brief.description}\n` : '') +
      (brief?.examples?.length ? `Örnek fikirler: ${brief.examples.join(' | ')}\n` : '') +
      style +
      (brief?.hashtags?.length ? `Nişin temel hashtag'leri: ${brief.hashtags.join(' ')}\n` : '') +
      (recentTitles.length ? `Daha önce yapılanlar (bunları ve benzerlerini TEKRAR ETME): ${recentTitles.join(' | ')}\n` : '') +
      `\nBu kanal için ${seconds} saniyelik tek bir viral yapay zeka videosu fikri üret.\n` +
      'Kurallar:\n' +
      '- İlk saniyede dikkat çeken, sonunda küçük bir sürpriz/espri olan, tekrar izletecek bir an.\n' +
      '- prompt İngilizce; tek sahne, dikey 9:16, sinematik; ne olduğunu, kamerayı, ışığı ve sesleri (efekt/müzik) tarif et. ' +
      'No speech, no dialogue, no voiceover. No text, letters, subtitles, logos or watermarks in the video. ' +
      'No real people, celebrities, brands or copyrighted characters.\n' +
      '- hookText ve açıklama Türkçe, doğal ve merak uyandıran.',
    config: { responseMimeType: 'application/json', responseJsonSchema: CHANNEL_IDEA_SCHEMA },
  });
  return JSON.parse(response.text);
}

module.exports = { generateIdeas, generateProductPlan, suggestNiches, generateChannelIdea };
