require('dotenv').config();
const log = require('./services/logger');
log.captureConsole(); // mevcut console.error/warn çağrıları da panel günlüğüne düşsün
const app = require('./app');
const { startDbConnection } = require('./config/db');
const { startBot } = require('./bots/telebot');
const cryptoScanner = require('./services/crypto/scanner.service');
const tiktokVideos = require('./services/tiktok/video.service');
const tiktokRenders = require('./services/tiktok/render.service');
const productVideos = require('./services/tiktok/autovideo.service');
const channels = require('./services/channel/channel.service');

// Yakalanmamış hata: önce günlüğe yaz, sonra çık (Passenger/Docker yeniden başlatır; Node varsayılanı da buydu)
for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
        log.error('sunucu', `${event}: ${err?.stack || err}`);
        setTimeout(() => process.exit(1), 800);
    });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    log.info('sunucu', `Sunucu başladı (port ${PORT}, Node ${process.version}, pid ${process.pid})`);
});

startDbConnection();
startBot();
cryptoScanner.resumeIfRunning();
require('./services/crypto/trader.service').start();
tiktokVideos.resume();
tiktokRenders.resume();
productVideos.resume();
channels.resume();
