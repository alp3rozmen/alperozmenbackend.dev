const { startBot } = require("./telebot");
const { startDbConnections } = require('./dbConnection');

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const blogRoutes = require('./routes/blog');
const instagramRoutes = require('./routes/instagram');
const campaignRoutes = require('./routes/campaings');
const carRoutes = require('./routes/cars');
const fortuneTellerAuthRoutes = require('./routes/FortuneTellerRoutes/auth');
const fortuneRoutes = require('./routes/FortuneTellerRoutes/fortunes')
const mhrsautorandevu = require('./routes/mhrsautorandevu/index');
const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/blogs', blogRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/cars', carRoutes);
app.use('/api/fortune-teller/auth', fortuneTellerAuthRoutes);
app.use('/api/fortune-teller/fortunes', fortuneRoutes);
app.use('/api/mhrs-autorandevu', mhrsautorandevu);

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

startDbConnections();
startBot();
