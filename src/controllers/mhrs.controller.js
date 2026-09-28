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

    // 1) Login
    const loginresp = await functions.girisYap(tckimlik, sifre);
    const token = `Bearer ${loginresp.data.jwt}`;

    // 2) İller
    const iller = await functions.illeriAl(token);
    const ilSade = functions.yaziSadele(ilPrompt);

    const il = iller.find((a) =>
      Number.isNaN(Number(ilSade))
        ? functions.yaziSadele(a.text).includes(ilSade)
        : a.value === Number(ilSade)
    );

    if (!il) return res.status(400).json({ message: "Belirtilen il bulunamadı" });

    // 3) İlçe
    let ilce;
    const ilceSade = functions.yaziSadele(ilcePrompt || "");

    if (ilceSade !== "f") {
      const ilceler = await functions.ilinIlceleri(token, il.value);
      ilce = ilceler.find((a) =>
        functions.yaziSadele(a.text).includes(ilceSade)
      );

      if (!ilce)
        return res.status(400).json({ message: "Belirtilen ilçe bulunamadı" });
    } else {
      ilce = "f";
    }

    // 4) Klinik
    const klinikler = await functions.klinikleriAl(
      token,
      il.value,
      ilce === "f" ? -1 : ilce.value
    );

    const klinikSade = functions.yaziSadele(klinikPrompt);
    const klinik =
      klinikler.find((a) => functions.yaziSadele(a.text) === klinikSade) ||
      klinikler.find((a) => functions.yaziSadele(a.text).includes(klinikSade));

    if (!klinik)
      return res.status(400).json({ message: "Belirtilen klinik bulunamadı" });

    // 5) Cinsiyet
    const c = cinsiyet?.toUpperCase();
    if (c !== "E" && c !== "K" && c !== "F") {
      return res.status(400).json({ message: "Geçersiz cinsiyet" });
    }

    // 6) Gün doğrulama
    if (isNaN(onumuzdekiGun) || onumuzdekiGun < 1 || onumuzdekiGun > 15)
      return res.status(400).json({ message: "Geçersiz gün sayısı" });

    // 7) Sıklık doğrulama
    if (isNaN(kontrolSiklik) || kontrolSiklik < 1 || kontrolSiklik > 30)
      return res.status(400).json({ message: "Geçersiz kontrol sıklığı" });

    // 8) Kontrol döngüsü başlat
    mhrsService.kontrolDongusuBaslat(token, il, ilce, c, klinik, onumuzdekiGun, kontrolSiklik);

    // 9) Başlangıç cevabı
    res.json({
      message: "Oto randevu kontrolü başlatıldı",
      il: il.text,
      ilce: ilce === "f" ? "Fark etmez" : ilce.text,
      klinik: klinik.text,
      cinsiyet: c,
      gun: onumuzdekiGun,
      siklikDakika: kontrolSiklik,
    });

  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ message: "Sunucu hatası", error: err.message });
  }
};
