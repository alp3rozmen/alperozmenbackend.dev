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
    return new Error('Bu model ücretsiz planda kullanılamıyor. Google AI Studio\'da (aistudio.google.com) projeye faturalandırma (billing) ekle.');
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

const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Dolap ilan başlığı, en fazla 60 karakter' },
    description: { type: 'string', description: 'İlan açıklaması, satır sonlarıyla, düz metin' },
    category: { type: 'string', description: 'Dolap kategori yolu, örn. Ev & Yaşam > Dekorasyon' },
    priceMin: { type: 'number' },
    priceMax: { type: 'number' },
    priceSuggested: { type: 'number' },
    priceReason: { type: 'string', description: 'Fiyat önerisinin kısa gerekçesi' },
    headline: { type: 'string', description: 'Görsel için 2-5 kelimelik çarpıcı slogan' },
    features: { type: 'array', items: { type: 'string' }, description: 'Görsel için 4 kısa özellik (2-4 kelime)' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'description', 'category', 'priceMin', 'priceMax', 'priceSuggested', 'priceReason', 'headline', 'features', 'tags'],
};

// Filament gramajı ve kg fiyatı biliniyorsa malzeme maliyeti
async function materialCost(grams) {
  const perKg = Number(await Setting.get('filament_price_per_kg'));
  if (!grams || !perKg) return null;
  return (grams / 1000) * perKg;
}

async function generateListing({ photos, notes, grams, printHours }) {
  const ai = await client();
  const brand = await Setting.get('dolap_brand_name');
  const cost = await materialCost(grams);

  const facts = [
    `Marka: ${brand}`,
    'Üretim: 3D yazıcı ile basılmış, Porima marka PLA filament',
    notes && `Satıcının notu: ${notes}`,
    grams && `Filament kullanımı: ${grams} gram`,
    cost && `Malzeme maliyeti: yaklaşık ${cost.toFixed(0)} TL`,
    printHours && `Baskı süresi: ${printHours} saat`,
  ].filter(Boolean).join('\n');

  const response = await generate(ai, {
    model: await Setting.get('gemini_text_model'),
    contents: [
      ...photos.map(imagePart),
      {
        text: `Fotoğraflardaki ürün için Dolap'ta yayınlanacak bir ilan hazırla.\n\n${facts}\n\n` +
          'Kurallar:\n' +
          '- Başlık aranabilir olsun: ürün türü + öne çıkan özellik, en fazla 60 karakter, emoji yok.\n' +
          '- Açıklama samimi ama profesyonel olsun; kısa giriş, madde işaretli özellikler (• ile), malzeme ve ' +
          'ölçü bilgisi (biliniyorsa), kargo/paketleme notu. Bilmediğin ölçü veya özelliği uydurma.\n' +
          '- Açıklamada paragrafları ve her maddeyi ayrı satıra yaz (\\n satır sonu kullan).\n' +
          '- Kategori Dolap\'ta gerçekten bulunan bir kategori yolu olsun.\n' +
          '- Fiyatı Türkiye\'deki benzer 3D baskı ürünlerinin piyasasına, malzeme maliyetine, baskı süresine ve ' +
          'Dolap komisyonuna göre TL olarak öner; tam sayı kullan.\n' +
          '- Tüm metinler Türkçe olsun.',
      },
    ],
    config: {
      systemInstruction: 'Sen Dolap ve Türkiye e-ticaret pazarını iyi bilen, 3D baskı ürünleri satan bir satıcıya ilan hazırlayan uzmansın.',
      responseMimeType: 'application/json',
      responseJsonSchema: LISTING_SCHEMA,
    },
  });

  const listing = JSON.parse(response.text);
  return { ...listing, materialCost: cost };
}

async function generateImage({ photos, template, listing, instructions }) {
  const ai = await client();
  const brand = await Setting.get('dolap_brand_name');

  const parts = [];
  parts.push({ text: `Ürün fotoğrafları (${photos.length} adet) — ürünün görünüşü için TEK kaynak bunlar:` });
  photos.forEach((p) => parts.push(imagePart(p)));
  if (template) {
    parts.push({ text: 'Stil şablonu — sadece düzen, tipografi, renk paleti ve kompozisyon için referans:' });
    parts.push(imagePart(template));
  }

  const lines = [
    'Dolap ilanı için tek bir kare (1:1) ürün tanıtım görseli oluştur.',
    '- Ürünü fotoğraflardaki gibi birebir koru: şekil, renk, logo, doku ve oranlar değişmesin; olmayan parça ekleme.',
    '- Fotoğraflarda farklı açılar/durumlar varsa bunları ayrı paneller halinde göster.',
    template
      ? '- Şablonun yerleşimini, yazı stilini ve renk dilini uygula; şablondaki ürünü ve yazıları KULLANMA, hepsini bu ürüne göre yeniden yaz.'
      : '- Koyu, sıcak ışıklı, premium bir stüdyo/masa atmosferi kullan; sade ve modern tipografi.',
    `- Marka adı: "${brand}" (üstte ve altta logo gibi yazılsın).`,
    listing?.headline && `- Ana slogan: "${listing.headline}"`,
    listing?.features?.length && `- Özellikler (ikonlarla): ${listing.features.map((f) => `"${f}"`).join(', ')}`,
    '- Tüm yazılar Türkçe ve yazım hatasız olsun; ekstra uydurma metin ekleme.',
    instructions && `- Ek istek: ${instructions}`,
  ].filter(Boolean);
  parts.push({ text: lines.join('\n') });

  const response = await generate(ai, {
    model: await Setting.get('gemini_image_model'),
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  });

  const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!image) {
    const reason = response.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason || 'bilinmiyor';
    throw new Error('Görsel üretilemedi (' + reason + ')');
  }
  return { mimeType: image.mimeType, data: image.data };
}

module.exports = { generateListing, generateImage };
