# Blog Backend API

Bu proje, Node.js (Express) ve MongoDB kullanarak JWT authentication destekli bir blog API'si sağlar. Temel özellikler:
- Blog yazısı ekleme (insert)
- Blog yazılarını listeleme (get)
- Blog yazısı silme (delete)
- Blog yazısı güncelleme (update)
- JWT ile kimlik doğrulama

## Kurulum

1. Bağımlılıkları yükleyin:
   ```
   npm install
   ```
2. Ortam değişkenlerini `.env` dosyasında ayarlayın (örnek: `MONGODB_URI`, `JWT_SECRET`).
3. Sunucuyu başlatın:
   ```
   npm run dev
   ```

## API Endpointleri
- `POST /api/auth/register` - Kullanıcı kaydı
- `POST /api/auth/login` - Giriş
- `GET /api/blogs` - Blogları listele
- `POST /api/blogs` - Blog ekle (JWT gerekli)
- `PUT /api/blogs/:id` - Blog güncelle (JWT gerekli)
- `DELETE /api/blogs/:id` - Blog sil (JWT gerekli)

## Notlar
- Tüm korumalı endpointlerde JWT token gereklidir.
- Daha fazla bilgi için kodu inceleyin.
#   a l p e r o z m e n b a c k e n d . d e v  
 