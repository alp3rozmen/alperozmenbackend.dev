const mongoose = require('mongoose');
require('dotenv').config();

  const mainDb = mongoose.createConnection(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  
  const fortuneDb = mongoose.createConnection(process.env.MONGOFORT_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  const startDbConnections = () => {
    mainDb.on('error', console.error.bind(console, 'Main MongoDB connection error:'));
    fortuneDb.on('error', console.error.bind(console, 'Fortune MongoDB connection error:'));
    mainDb.once('open', () => console.log('Main MongoDB connected'));
    fortuneDb.once('open', () => console.log('Fortune MongoDB connected'));
  }

  module.exports = { mainDb, fortuneDb, startDbConnections };