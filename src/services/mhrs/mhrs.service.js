const moment = require("moment");
moment.locale("tr");
const functions = require("./mhrs.api");
let denemeSayisi = 0;

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

// kontrolEt'i her `kontrolSiklik` dakikada bir çalıştırır.
function kontrolDongusuBaslat(token, il, ilce, cinsiyet, klinik, onumuzdekiGun, kontrolSiklik) {
	const kontrolDongusu = () => {
		kontrolEt(token, il, ilce, cinsiyet, klinik, onumuzdekiGun);
		setTimeout(kontrolDongusu, Number(kontrolSiklik) * 60000);
	};

	kontrolDongusu();
}

module.exports = { kontrolEt, kontrolDongusuBaslat };
