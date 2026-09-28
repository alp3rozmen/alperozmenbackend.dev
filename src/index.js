require('dotenv').config();
const app = require('./app');
const { startDbConnection } = require('./config/db');
const { startBot } = require('./bots/telebot');

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

startDbConnection();
startBot();
