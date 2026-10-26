require('dotenv').config();
const fs = require('fs');
const path = require('path');
const log = require('./services/logger');
log.captureConsole(); // mevcut console.error/warn çağrıları da panel günlüğüne düşsün
const app = require('./app');
const { startDbConnection } = require('./config/db');
const migrations = require('./config/migrations');
const { startBot } = require('./bots/telebot');
const cryptoScanner = require('./services/crypto/scanner.service');
const tiktokVideos = require('./services/tiktok/video.service');
const tiktokRenders = require('./services/tiktok/render.service');
const productVideos = require('./services/tiktok/autovideo.service');
const channels = require('./services/channel/channel.service');

// Çökme sebebi önce senkron olarak dosyaya yazılır: veritabanı yazımı çıkıştan önce yetişmeyebilir ya da günlük kapalı olabilir.
// storage/ git'e girmediği için yayınlamalarda silinmez; 1 MB'ı geçince eski dosya .1 olarak saklanır.
const CRASH_LOG = path.join(__dirname, '..', 'storage', 'crash.log');

function writeCrashLog(text) {
    try {
        fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
        if (fs.existsSync(CRASH_LOG) && fs.statSync(CRASH_LOG).size > 1024 * 1024) fs.renameSync(CRASH_LOG, `${CRASH_LOG}.1`);
        fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${text}\n\n`);
    } catch {
        // dosyaya yazılamazsa en azından konsola (passenger.log) düşer
    }
}

// Yakalanmamış hata: dosyaya ve günlüğe yaz, sonra çık (Passenger/Docker yeniden başlatır; Node varsayılanı da buydu)
for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
        const text = `${event}: ${err?.stack || err}`;
        writeCrashLog(text);
        log.error('sunucu', text, { force: true });
        setTimeout(() => process.exit(1), 800);
    });
}

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
    log.info('sunucu', `Sunucu başladı (port ${PORT}, Node ${process.version}, pid ${process.pid})`);
});

// Gavelon oyun sunucusu (WebSocket): aynı HTTP sunucusuna bağlanır, yalnızca bu yoldaki yükseltmeleri alır.
// Hata verirse backend'in geri kalanı etkilenmesin.
try {
    const wsPath = process.env.GAVELON_WS_PATH || '/gavelon-ws';
    require('./services/gavelon/game-server').attachGameServer(server, { path: wsPath });
    log.info('gavelon', `Oyun sunucusu hazır (WebSocket yolu ${wsPath})`);
} catch (err) {
    log.error('gavelon', `Oyun sunucusu başlatılamadı: ${err.message}`);
}

startDbConnection();
// Servisler eksik sütunlar eklendikten sonra başlasın; yoksa eski tablodaki yeni sütunu sorgulayıp hata verirler
migrations.run()
    .catch((err) => log.error('sunucu', `Veritabanı sütun kontrolü başarısız: ${err.message}`))
    .finally(() => {
        startBot();
        cryptoScanner.resumeIfRunning();
        require('./services/crypto/trader.service').start();
        tiktokVideos.resume();
        tiktokRenders.resume();
        productVideos.resume();
        channels.resume();
    });
