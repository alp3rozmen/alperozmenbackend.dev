const express = require('express');
const cors = require('cors');
const routes = require('./routes');

const app = express();
// cPanel/Passenger bir proxy arkasında; rate limit için gerçek istemci IP'si X-Forwarded-For'dan alınır
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// cPanel (Passenger) Application URL'deki alt yolu (örn. /admin) silmeden iletir.
// BASE_PATH ile o önek eklenir; yerelde boş bırakılır.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
app.use(`${BASE_PATH}/api`, routes);

module.exports = app;
