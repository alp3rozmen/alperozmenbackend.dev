// MHRS, çoğu hesapta T.C.+şifre ile doğrudan girişi kapatıp e-Devlet/e-Nabız SSO'ya
// geçti. SSO girişi SMS doğrulaması içerdiği için güvenilir şekilde otomatikleştirilemez
// (ve denenmemeli). Bu script onu otomatikleştirmez: senin bilgisayarında gerçek bir
// Chrome penceresi açar, SMS dahil tüm girişi SEN yaparsın. Script sadece, sen giriş
// yaptıktan sonra tarayıcının MHRS API'sine attığı isteklerdeki Authorization başlığını
// pasif olarak izleyip oturum token'ını yakalar — DevTools'ta elle yaptığın işi otomatikleştirir.
//
// Kullanım:
//   cd tools/mhrs-token
//   npm install
//   npm start
//
// Sadece kendi bilgisayarında, kendi hesabınla kullan. Yakalanan token kimseyle paylaşılmamalı;
// panoya kopyalanır ve hiçbir yere kaydedilmez/gönderilmez.

const { chromium } = require("playwright-core");
const { execSync } = require("child_process");

const HEDEF_URL = "https://www.mhrs.gov.tr/";
const API_DESENI = "prd.mhrs.gov.tr/api";
const ZAMAN_ASIMI_MS = 10 * 60 * 1000; // 10 dakika

function panoyaKopyala(metin) {
	try {
		if (process.platform === "win32") {
			execSync("clip", { input: metin });
		} else if (process.platform === "darwin") {
			execSync("pbcopy", { input: metin });
		} else {
			execSync("xclip -selection clipboard", { input: metin });
		}
		return true;
	} catch {
		return false;
	}
}

async function main() {
	console.log("Chrome açılıyor...");
	let browser;
	try {
		// channel: 'chrome' bilgisayarındaki kurulu Chrome'u kullanır, ayrı tarayıcı indirmez
		browser = await chromium.launch({ channel: "chrome", headless: false });
	} catch (err) {
		console.error(
			"Chrome açılamadı. Google Chrome kurulu değilse https://www.google.com/chrome/ adresinden kurup tekrar dene.",
		);
		console.error(err.message);
		process.exit(1);
	}

	const context = await browser.newContext();
	const page = await context.newPage();

	let yakalananToken = null;

	page.on("request", (req) => {
		if (yakalananToken) return;
		if (!req.url().includes(API_DESENI)) return;
		const auth = req.headers()["authorization"];
		if (auth && auth.startsWith("Bearer ")) {
			yakalananToken = auth.slice("Bearer ".length).trim();
		}
	});

	await page.goto(HEDEF_URL);

	console.log("");
	console.log("Açılan pencerede e-Devlet (veya e-Nabız) ile normal şekilde giriş yap, SMS kodunu gir.");
	console.log("Giriş bitip randevu/ana sayfan açılınca bu terminale otomatik dönülecek, bekle...");
	console.log("");

	const baslangic = Date.now();
	while (!yakalananToken) {
		if (Date.now() - baslangic > ZAMAN_ASIMI_MS) {
			console.error("10 dakika içinde giriş tamamlanmadı, vazgeçiliyor.");
			await browser.close();
			process.exit(1);
		}
		if (browser.contexts().length === 0 || page.isClosed()) {
			console.error("Tarayıcı penceresi kapatıldı, vazgeçiliyor.");
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}

	console.log("Token yakalandı. Tarayıcı kapatılıyor...");
	await browser.close();

	console.log("");
	console.log("=== MHRS OTURUM TOKEN'I (gizli tut, kimseyle paylaşma) ===");
	console.log(yakalananToken);
	console.log("============================================================");

	if (panoyaKopyala(yakalananToken)) {
		console.log("");
		console.log("Panoya kopyalandı. Panelde MHRS sayfasındaki 'token' alanına yapıştırıp Başlat'a basabilirsin.");
	} else {
		console.log("");
		console.log("Panoya otomatik kopyalanamadı, yukarıdaki değeri elle kopyala.");
	}
}

main().catch((err) => {
	console.error("Beklenmeyen hata:", err);
	process.exit(1);
});
