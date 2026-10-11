const Setting = require('../../models/Setting');
const { client, generate } = require('../tiktok/gemini');

// Gemini haberleri sadece filtre olarak kullanılır: fiyat tahmini yapmaz, alım kararını teknik sinyal verir.
// Haber kontrolü hata verirse işlem engellenmez (teknik sinyal yine geçerli); sebep loglanır.

const VERDICT_RE = /KARAR:\s*(GİR|GIR|GİRME|GIRME)/i;

// Alımdan önce: son 7 günde coin için ciddi olumsuz haber var mı?
async function checkCoin(pair) {
  const symbol = pair.replace('_USDT', '');
  const ai = await client();
  const response = await generate(ai, {
    model: await Setting.get('gemini_text_model'),
    contents:
      `Kripto para ${symbol} (borsa sembolü ${symbol}, Gate.io ${pair}) için son 7 günün haberlerini Google'da ara. ` +
      'Şu ciddi olumsuz durumlardan biri var mı: hack/exploit, büyük borsadan (özellikle Gate.io) delist duyurusu, ' +
      'önümüzdeki 7 gün içinde dolaşımdaki arzın %2\'sinden büyük token kilidi açılması, ekip/rug pull şüphesi, ' +
      'regülasyon yasağı veya dava, stablecoin depeg, ağ durması. Normal fiyat dalgalanması ya da genel piyasa haberi sayılmaz.\n' +
      'Cevabın İLK satırı tam olarak "KARAR: GİR" veya "KARAR: GİRME" olsun. İkinci satır "NEDEN: " ile başlayan tek cümle. ' +
      'Emin değilsen veya haber bulamazsan "KARAR: GİR" yaz.',
    config: { tools: [{ googleSearch: {} }] },
  });
  const text = (response.text || '').trim();
  const match = text.match(VERDICT_RE);
  const reason = (text.match(/NEDEN:\s*(.+)/i)?.[1] || text.split('\n')[1] || '').trim().slice(0, 400);
  const avoid = !!match && /GİRME|GIRME/i.test(match[1]);
  return { avoid, reason: reason || (match ? '' : 'Gemini cevabı anlaşılamadı, teknik sinyalle devam') };
}

const OPPORTUNITY_SCHEMA = {
  type: 'object',
  properties: {
    coins: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Borsa sembolü, büyük harf, örn. "ARB"' },
          reason: { type: 'string', description: 'Olumlu haberin kısa Türkçe özeti ve tarihi' },
        },
        required: ['symbol', 'reason'],
      },
    },
  },
  required: ['coins'],
};

// Günde birkaç kez: son 48 saatte somut olumlu katalizörü olan coinler (aday listesine eklenir, yine teknik sinyal şart)
async function findOpportunities() {
  const ai = await client();
  const model = await Setting.get('gemini_text_model');
  const research = await generate(ai, {
    model,
    contents:
      'Son 48 saatte somut olumlu bir haber/katalizör yaşayan altcoinleri Google\'da araştır: büyük borsada (Binance, Coinbase, ' +
      'Upbit, OKX) yeni listeleme duyurusu, mainnet/önemli ağ güncellemesi, büyük kurumsal ortaklık, ETF/ETP onayı, ' +
      'token geri alım/yakım programı. Sadece söylentiye değil resmi duyuruya dayananları yaz. Spekülatif meme coin pompalarını alma. ' +
      'Her biri için sembol, haber ve tarih. Türkçe, kısa maddeler.',
    config: { tools: [{ googleSearch: {} }] },
  });
  const response = await generate(ai, {
    model,
    contents: `Araştırma:\n${research.text || ''}\n\nBu araştırmadan en fazla 8 coin çıkar. Sembolü kesin olmayanı alma. ` +
      'BTC, ETH ve stablecoinleri alma.',
    config: { responseMimeType: 'application/json', responseJsonSchema: OPPORTUNITY_SCHEMA },
  });
  return JSON.parse(response.text).coins
    .map((c) => ({ symbol: String(c.symbol).toUpperCase().replace(/[^A-Z0-9]/g, ''), reason: c.reason }))
    .filter((c) => c.symbol);
}

module.exports = { checkCoin, findOpportunities };
