const express = require('express');
const cors = require('cors');
const routes = require('./routes');

const app = express();
app.use(cors());
app.use(express.json());

// cPanel (Passenger) Application URL'deki alt yolu (örn. /admin) silmeden iletir.
// BASE_PATH ile o önek eklenir; yerelde boş bırakılır.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
app.use(`${BASE_PATH}/api`, routes);

module.exports = app;
