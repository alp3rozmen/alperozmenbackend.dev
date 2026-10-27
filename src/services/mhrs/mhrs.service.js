const moment = require("moment");
moment.locale("tr");
const functions = require("./mhrs.api");
const telegram = require("../telegram");

const LOG_LIMIT = 100;

// Aynı anda tek iş çalışır. Giriş bilgileri sadece token yenilemek için bellekte tutulur, diske yazılmaz ve dışarı verilmez.
let job = null;

function log(mesaj) {
	const satir = `${moment().format("DD.MM.YYYY HH:mm:ss")} ${mesaj}`;
	console.log(`[mhrs] ${mesaj}`);
	job.loglar.push(satir);
	if (job.loglar.length > LOG_LIMIT) job.loglar.shift();
}

// bildir: Telegram'a da haber verilsin mi (kullanıcı panelde olmayabilir)
function bitir(durum, mesaj, bildir = false) {
	clearTimeout(job.zamanlayici);
	job.zamanlayici = null;
	job.durum = durum;
	job.bitisZamani = new Date().toISOString();
	log(mesaj);
	if (bildir) {
		telegram.sendMessage(`🏥 <b>MHRS Oto Randevu</b>\n${telegram.escapeHtml(mesaj)}`).catch((e) =>
			console.error("[mhrs] Telegram bildirimi gönderilemedi:", e.message),
		);
	}
}

// e-Devlet zorunluluğu sonrası şifreyle giriş genelde çalışmıyor; yalnızca eski
// şifreli hesaplar için destekleniyor. Token modunda yenileme yapılamaz, hesap
// sahibinin tarayıcıdan yeni bir token alıp tekrar başlatması gerekir.
async function tokenYenile() {
	if (job.mod !== "sifre") {
		const err = new Error("Oturum süresi doldu, token modunda otomatik yenilenemez.");
		err.yenilenemez = true;
		throw err;
	}
	const loginresp = await functions.girisYap(job.kimlik.tckimlik, job.kimlik.sifre);
	job.token = `Bearer ${loginresp.data.jwt}`;
	log("Oturum yenilendi.");
}

function yetkiHatasi(err) {
	const kod = err.response?.status;
	return kod === 401 || kod === 403;
}

// Slot listesini düzleştirir: hekim -> muayene yeri -> saat -> slot
function bosSlotlar(hekim) {
	const slotlar = [];
	for (const hekimSlot of hekim.hekimSlotList || []) {
		for (const yer of hekimSlot.muayeneYeriSlotList || []) {
			for (const saat of yer.saatSlotList || []) {
				if (saat.bos !== true) continue;
				for (const s of saat.slotList || []) {
					if (s.bos === true) slotlar.push(s.slot);
				}
			}
		}
	}
	return slotlar;
}

async function kontrolEt() {
	const { il, ilce, cinsiyet, klinik, onumuzdekiGun } = job.parametreler;
	const token = job.token;

	const randevular = await functions.kullaniciRandevulari(token);
	const mevcutRandevu = randevular.aktifRandevuDtoList.some(
		(a) => a.mhrsKlinikAdi === klinik.text && a.randevuKayitDurumu.val !== 4,
	);

	if (mevcutRandevu) {
		bitir("tamamlandi", "Zaten bu klinikte bir randevunuz var, kontrol durduruldu.", true);
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
		baslangicTarihi,
		bitisTarihi,
	);

	if (!randevuVerisi.hastane || randevuVerisi.hastane.length === 0) {
		job.denemeSayisi++;
		log(`Randevu bulunamadı - ${job.denemeSayisi}. deneme`);
		return;
	}

	// En yakın tarihli hastaneden başlayarak sırayla dene
	const hastaneler = [...randevuVerisi.hastane].sort(
		(a, b) =>
			new Date(a.baslangicZamani).getTime() -
			new Date(b.baslangicZamani).getTime(),
	);

	for (const hastane of hastaneler) {
		const hekimVerisi = await functions.hekimAra(
			token,
			il.value,
			cinsiyet,
			klinik.value,
			hastane.kurum.mhrsKurumId,
			hastane.hekim.mhrsHekimId,
		);

		const kullanilabilirHekimler = hekimVerisi.filter(
			(hekim) => hekim.kalanKullanim > 0,
		);

		for (const hekim of kullanilabilirHekimler) {
			const slotlar = bosSlotlar(hekim);
			if (slotlar.length === 0) continue;

			const slot = slotlar[0];
			const resp = await functions.randevuAl(
				token,
				slot.id,
				slot.fkCetvelId,
				slot.baslangicZamani,
				slot.bitisZamani,
			);

			job.sonuc = {
				hekim: `${resp.hekim.ad} ${resp.hekim.soyad}`,
				kurum: `${resp.kurum.kurumAdi} (${resp.kurum.ilAdi}-${resp.kurum.ilceAdi})`,
				tarih: `${resp.randevuBaslangicZamaniStr.zaman} - ${resp.randevuBitisZamaniStr.saat}`,
			};
			bitir(
				"tamamlandi",
				`Randevu alındı! Hekim: ${job.sonuc.hekim} | Kurum: ${job.sonuc.kurum} | Tarih: ${job.sonuc.tarih}`,
				true,
			);
			return;
		}
	}

	job.denemeSayisi++;
	log(`Hekim bulundu, fakat uygun randevu bulunamadı - ${job.denemeSayisi}. deneme`);
}

async function tur() {
	const calisan = job;
	calisan.sonKontrol = new Date().toISOString();

	try {
		try {
			await kontrolEt();
		} catch (err) {
			// Token süresi dolduysa yeniden giriş yapıp aynı turu bir kez daha dene
			if (!yetkiHatasi(err) || job !== calisan) throw err;
			await tokenYenile();
			await kontrolEt();
		}
	} catch (err) {
		if (job !== calisan) return;
		if (err.yenilenemez) {
			bitir(
				"hata",
				"Oturum süresi doldu. Tarayıcıdan tekrar e-Devlet ile giriş yapıp yeni token ile kontrolü yeniden başlatın.",
				true,
			);
		} else if (yetkiHatasi(err)) {
			bitir("hata", `Oturum yenilenemedi: ${err.message}. Kontrol durduruldu.`, true);
		} else if (err.response?.data?.errors?.[0]?.kodu === "RND4010") {
			job.denemeSayisi++;
			log(`Randevu bulunamadı - ${job.denemeSayisi}. deneme`);
		} else {
			log(`Randevu kontrolü sırasında bir hata oluştu: ${err.message}`);
		}
	}

	// Önceki tur bitmeden yenisi başlamasın; durdurulduysa veya bittiyse devam etme
	if (job === calisan && job.durum === "calisiyor") {
		job.zamanlayici = setTimeout(tur, job.parametreler.kontrolSiklik * 60000);
	}
}

// mod: 'sifre' (tckimlik+sifre ile, token süresi dolunca otomatik yenilenir) veya
// 'token' (tarayıcıdan alınan hazır token, süresi dolunca elle yenilenmesi gerekir)
function baslat(mod, kimlik, token, parametreler) {
	if (job && job.durum === "calisiyor") {
		const err = new Error("Zaten çalışan bir kontrol var, önce durdurun.");
		err.status = 409;
		throw err;
	}

	job = {
		durum: "calisiyor",
		mod,
		kimlik,
		token,
		parametreler,
		denemeSayisi: 0,
		baslangicZamani: new Date().toISOString(),
		bitisZamani: null,
		sonKontrol: null,
		sonuc: null,
		loglar: [],
		zamanlayici: null,
	};
	log("Kontrol başlatıldı.");
	tur();
}

function durdur() {
	if (!job || job.durum !== "calisiyor") return false;
	bitir("durduruldu", "Kontrol kullanıcı tarafından durduruldu.");
	return true;
}

function durum() {
	if (!job) return { durum: "bosta" };
	const { il, ilce, cinsiyet, klinik, onumuzdekiGun, kontrolSiklik } = job.parametreler;
	return {
		durum: job.durum,
		mod: job.mod,
		il: il.text,
		ilce: ilce === "f" ? "Fark etmez" : ilce.text,
		klinik: klinik.text,
		cinsiyet,
		gun: Number(onumuzdekiGun),
		siklikDakika: kontrolSiklik,
		denemeSayisi: job.denemeSayisi,
		baslangicZamani: job.baslangicZamani,
		bitisZamani: job.bitisZamani,
		sonKontrol: job.sonKontrol,
		sonuc: job.sonuc,
		loglar: job.loglar,
	};
}

module.exports = { baslat, durdur, durum };
