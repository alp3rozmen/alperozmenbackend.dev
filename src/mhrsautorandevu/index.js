const moment = require("moment");
moment.locale("tr");
const prompt = require("prompt-sync")({ sigint: true });
const functions = require("./functions.js");
const express = require('express');
const router = express.Router();
let denemeSayisi = 0;
const auth = require('../../middleware/auth.js');


async function kontrolEt(token, il, ilce, cinsiyet, klinik, onumuzdekiGun) {
	try {
		const randevular = await functions.kullaniciRandevulari(token);
		const mevcutRandevu = randevular.aktifRandevuDtoList.some(
			(a) => a.mhrsKlinikAdi === klinik.text && a.randevuKayitDurumu.val !== 4,
		);

		if (mevcutRandevu) {
			console.log("Zaten bu klinikte bir randevunuz var, sistem durduruldu.");
			process.exit();
			return;
		}

		const baslangicTarihi = moment().format("YYYY-MM-DD HH:mm:ss");
		const bitisTarihi = moment()
			.add(Number(onumuzdekiGun), "days")
			.format("YYYY-MM-DD HH:mm:ss");

		const randevuVerisi = await functions.randevuAra(
			token,
			il.value,
			ilce === "f" ? -1 : ilce.value,
			cinsiyet,
			klinik.value,
			String(baslangicTarihi),
			String(bitisTarihi),
		);

		if (!randevuVerisi.hastane || randevuVerisi.hastane.length === 0) {
			denemeSayisi++;
			console.log(`Randevu bulunamadı - ${denemeSayisi}. deneme`);
			return;
		}

		const enYakinHastane = randevuVerisi.hastane.sort(
			(a, b) =>
				new Date(a.baslangicZamani).getTime() -
				new Date(b.baslangicZamani).getTime(),
		)[0];

		const hekimVerisi = await functions.hekimAra(
			token,
			il.value,
			cinsiyet,
			klinik.value,
			enYakinHastane.kurum.mhrsKurumId,
			enYakinHastane.hekim.mhrsHekimId,
		);

		const kullanilabilirHekimler = hekimVerisi.filter(
			(hekim) => hekim.kalanKullanim > 0,
		);

		if (kullanilabilirHekimler.length > 0) {
			for (const hekim of kullanilabilirHekimler) {
				const saatler =
					hekim.hekimSlotList[0].muayeneYeriSlotList[0].saatSlotList.filter(
						(saat) => saat.bos === true,
					);

				const slotList = [];

				for (const saat of saatler) {
					for (const slot in saat.slotList) {
						slotList.push(slot);
					}
				}

				const alinabilirSlotlar = slotList.filter((a) => a.bos === true);

				if (alinabilirSlotlar.length > 0) {
					const alinacakSlot = alinabilirSlotlar[0].slot;
					const resp = await functions.randevuAl(
						token,
						alinacakSlot.id,
						alinacakSlot.fkCetvelId,
						alinacakSlot.baslangicZamani,
						alinacakSlot.bitisZamani,
					);

					console.log(
						`Randevu alındı!\nHekim adı: ${resp.hekim.ad} ${resp.hekim.soyad}\nKurum adı: ${resp.kurum.kurumAdi} (${resp.kurum.ilAdi}-${resp.kurum.ilceAdi})\nRandevu tarihi: ${resp.randevuBaslangicZamaniStr.zaman} - ${resp.randevuBitisZamaniStr.saat}`,
					);
					process.exit();
					return;
				}
			}
		}

		denemeSayisi++;
		console.log(
			`Hekim bulundu, fakat uygun randevu bulunamadı - ${denemeSayisi}. deneme`,
		);
	} catch (err) {
		if (err.response?.data?.errors?.[0]?.kodu === "RND4010") {
			denemeSayisi++;
			console.log(`Randevu bulunamadı - ${denemeSayisi}. deneme`);
		} else {
			console.error("Randevu kontrolü sırasında bir hata oluştu:", err.message);
		}
	}
}
router.post('/searchandclaim', auth, async (req, res) => {
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
    const kontrolDongusu = () => {
      kontrolEt(token, il, ilce, c, klinik, onumuzdekiGun);
      setTimeout(kontrolDongusu, Number(kontrolSiklik) * 60000);
    };

    kontrolDongusu();

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
});

module.exports = router;




