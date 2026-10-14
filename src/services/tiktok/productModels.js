// Ürün videosu (fotoğraftan video) için seçilebilen kie.ai modelleri. Her model farklı parametre istiyor;
// build() sahnenin prompt'u ve fotoğraf adreslerinden o modelin createTask input'unu üretir.
// Parametreler docs.kie.ai/market sayfalarından (Ekim 2026). Süre/çözünürlük değerleri modelin kabul ettikleriyle sınırlı.
// multiImage: ön + arka fotoğrafı referans alıp ürünü döndürebilir (@image1/@image2). Diğerleri tek fotoğrafı
// ilk kare olarak alıp hareketlendirir (arka fotoğraf sadece ekonomik moddaki fotoğraf sahnesinde kullanılır).
const PRODUCT_MODELS = {
  'grok-imagine/image-to-video': {
    label: 'Grok Imagine: en ucuz, sesli, ön+arka foto referansı (6 sn)',
    multiImage: true,
    build: ({ prompt, imageUrls }) => ({
      image_urls: imageUrls, prompt, duration: '6', resolution: '720p', aspect_ratio: '9:16', mode: 'normal',
    }),
  },
  'bytedance/v1-pro-fast-image-to-video': {
    label: 'Seedance V1 Pro Fast: sessiz, 5 sn, 720p',
    multiImage: false,
    build: ({ prompt, imageUrls }) => ({ prompt, image_url: imageUrls[0], duration: '5', resolution: '720p' }),
  },
  'hailuo/2-3-image-to-video-standard': {
    label: 'Hailuo 2.3 Standard: sessiz, 6 sn, 768p',
    multiImage: false,
    build: ({ prompt, imageUrls }) => ({ prompt, image_url: imageUrls[0], duration: '6', resolution: '768P' }),
  },
  'wan/2-6-image-to-video': {
    label: 'Wan 2.6: sessiz, 5 sn, 720p',
    multiImage: false,
    build: ({ prompt, imageUrls }) => ({ prompt, image_urls: [imageUrls[0]], duration: '5', resolution: '720p' }),
  },
  'kling-2.6/image-to-video': {
    label: 'Kling 2.6: en kaliteli, en pahalı, sessiz, 5 sn',
    multiImage: false,
    // Ses (sound) daha pahalı; ürün videosunda gerek yok
    build: ({ prompt, imageUrls }) => ({ prompt: prompt.slice(0, 2500), image_urls: [imageUrls[0]], sound: false, duration: '5' }),
  },
};

const DEFAULT_PRODUCT_MODEL = 'grok-imagine/image-to-video';

// Ayarda bilinmeyen bir değer kalmışsa varsayılana dön (eski serbest metin alanından kalma değerler)
function productModel(name) {
  const key = PRODUCT_MODELS[name] ? name : DEFAULT_PRODUCT_MODEL;
  return { name: key, ...PRODUCT_MODELS[key] };
}

module.exports = { PRODUCT_MODELS, DEFAULT_PRODUCT_MODEL, productModel };
