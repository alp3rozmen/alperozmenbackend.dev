// cPanel cron için: HTTP'ye (ve önündeki bot korumasına / uyuyan Passenger'a) takılmadan tek tur tarama.
// Örnek cron (5 dakikada bir):
//   */5 * * * * source /home/KULLANICI/nodevenv/UYGULAMA/20/bin/activate && cd /home/KULLANICI/UYGULAMA && node scripts/crypto-tick.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const scanner = require('../src/services/crypto/scanner.service');
const { db } = require('../src/config/db');

scanner.tickIfRunning()
  .then((result) => console.log(new Date().toISOString(), JSON.stringify(result)))
  .catch((err) => {
    console.error(new Date().toISOString(), 'Tarama hatası:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
