require('dotenv').config();
const app = require('./app');
const { startDbConnection } = require('./config/db');
const { startBot } = require('./bots/telebot');
const cryptoScanner = require('./services/crypto/scanner.service');

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

startDbConnection();
startBot();
cryptoScanner.resumeIfRunning();
