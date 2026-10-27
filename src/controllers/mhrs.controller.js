const functions = require("../services/mhrs/mhrs.api");
const mhrsService = require("../services/mhrs/mhrs.service");

exports.searchAndClaim = async (req, res) => {
  try {
    const {
      tckimlik,
      sifre,
      il: ilPrompt,
      ilce: ilcePrompt,
      klinik: klinikPrompt,
      cinsiyet,
      onumuzdekiGun,
      kontrolSiklik,
    } = req.body;

    if (!tckimlik || !sifre || !ilPrompt || !klinikPrompt)
      return res.status(400).json({ message: "T.C. kimlik, şifre, il ve klinik zorunlu" });

    if (mhrsService.durum().durum === "calisiyor")
      return res.status(409).json({ message: "Zaten çalışan bir kontrol var, önce durdurun." });

    // 1) Cinsiyet, gün, sıklık doğrulama (MHRS'ye gitmeden önce)
    const c = String(cinsiyet || "").toUpperCase();
    if (c !== "E" && c !== "K" && c !== "F")
      return res.status(400).json({ message: "Geçersiz cinsiyet" });

    const gun = Number(onumuzdekiGun);
    if (!Number.isInteger(gun) || gun < 1 || gun > 15)
      return res.status(400).json({ message: "Geçersiz gün sayısı" });

    const siklik = Number(kontrolSiklik);
    if (!Number.isFinite(siklik) || siklik < 1 || siklik > 30)
      return res.status(400).json({ message: "Geçersiz kontrol sıklığı" });

    // 2) Login
    let loginresp;
    try {
      loginresp = await functions.girisYap(tckimlik, sifre);
    } catch (err) {
      return res.status(401).json({ message: "MHRS girişi başarısız, T.C. kimlik ve şifreyi kontrol edin" });
    }
    const token = `Bearer ${loginresp.data.jwt}`;

    // 3) İller
    const iller = await functions.illeriAl(token);
    const ilSade = functions.yaziSadele(String(ilPrompt));

    const il = iller.find((a) =>
      Number.isNaN(Number(ilSade))
        ? functions.yaziSadele(a.text).includes(ilSade)
        : a.value === Number(ilSade)
    );

    if (!il) return res.status(400).json({ message: "Belirtilen il bulunamadı" });

    // 4) İlçe
    let ilce;
    const ilceSade = functions.yaziSadele(String(ilcePrompt || ""));

    if (ilceSade !== "f" && ilceSade !== "") {
      const ilceler = await functions.ilinIlceleri(token, il.value);
      ilce = ilceler.find((a) =>
        functions.yaziSadele(a.text).includes(ilceSade)
      );

      if (!ilce)
        return res.status(400).json({ message: "Belirtilen ilçe bulunamadı" });
    } else {
      ilce = "f";
    }

    // 5) Klinik
    const klinikler = await functions.klinikleriAl(
      token,
      il.value,
      ilce === "f" ? -1 : ilce.value
    );

    const klinikSade = functions.yaziSadele(String(klinikPrompt));
    const klinik =
      klinikler.find((a) => functions.yaziSadele(a.text) === klinikSade) ||
      klinikler.find((a) => functions.yaziSadele(a.text).includes(klinikSade));

    if (!klinik)
      return res.status(400).json({ message: "Belirtilen klinik bulunamadı" });

    // 6) Kontrol döngüsü başlat
    mhrsService.baslat(
      { tckimlik, sifre },
      token,
      { il, ilce, cinsiyet: c, klinik, onumuzdekiGun: gun, kontrolSiklik: siklik }
    );

    res.json({ message: "Oto randevu kontrolü başlatıldı", ...mhrsService.durum() });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error("Hata:", err.message);
    res.status(500).json({ message: "Sunucu hatası", error: err.message });
  }
};

exports.durum = (req, res) => {
  res.json(mhrsService.durum());
};

exports.durdur = (req, res) => {
  const durduruldu = mhrsService.durdur();
  res.json({
    message: durduruldu ? "Kontrol durduruldu" : "Çalışan kontrol yok",
    ...mhrsService.durum(),
  });
};
