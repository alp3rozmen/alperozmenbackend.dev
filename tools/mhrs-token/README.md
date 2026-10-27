# MHRS token yakalayıcı (yerel araç)

MHRS artık çoğu hesapta T.C.+şifre ile doğrudan girişi kapatıp e-Devlet/e-Nabız SSO'ya
zorluyor. SSO girişi SMS doğrulaması içerdiği için otomatikleştirilemez ve denenmemelidir.

Bu araç SMS adımını atlatmaz. Sadece şunu yapar: bilgisayarında gerçek bir Chrome penceresi
açar, sen normal şekilde (SMS dahil) giriş yaparsın, script arka planda tarayıcının MHRS
API'sine attığı isteklerdeki `Authorization` başlığını izleyip oturum token'ını yakalar —
normalde F12 → Network sekmesinde elle aradığın şeyi otomatikleştirir.

Bu klasör, panelin backend'inden (`backendalperozmen.dev`) bağımsızdır; sunucuya deploy
edilmez, sadece kendi bilgisayarında çalıştırılır.

## Kurulum ve kullanım

```
cd tools/mhrs-token
npm install
npm start
```

Açılan Chrome penceresinde e-Devlet veya e-Nabız ile normal şekilde giriş yap. Giriş
tamamlanınca terminalde token görünür ve panoya kopyalanır. Panelde
[/Mhrs](https://alperozmen.dev/Mhrs) sayfasındaki "Tarayıcıdan alınan token" alanına
yapıştırıp kontrolü başlat.

Token'ın bir süresi var; dolunca bot kendini durdurur ve Telegram'a haber verir. O zaman
bu aracı tekrar çalıştırıp yeni bir token alman gerekir.

## Güvenlik

- Token, hesabına e-Devlet şifresi kadar erişim vermez ama MHRS üzerinde seni temsil eder.
  Kimseyle paylaşma.
- Script token'ı hiçbir yere kaydetmez veya göndermez; sadece terminale yazar ve panoya kopyalar.
- `channel: "chrome"` kullanıldığı için ayrı bir tarayıcı indirilmez, bilgisayarındaki kurulu
  Google Chrome açılır. Chrome kurulu değilse önce https://www.google.com/chrome/ adresinden kur.
