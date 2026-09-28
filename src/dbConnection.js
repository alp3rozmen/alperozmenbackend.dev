const mongoose = require('mongoose');
require('dotenv').config();

let mainDb = null;
let fortuneDb = null;

const startDbConnections = () => {
  if (process.env.MONGODB_URI) {
    mainDb = mongoose.createConnection(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    mainDb.on('error', console.error.bind(console, 'Main MongoDB connection error:'));
    mainDb.once('open', () => console.log('Main MongoDB connected'));
  }

  if (process.env.MONGOFORT_URI) {
    fortuneDb = mongoose.createConnection(process.env.MONGOFORT_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    fortuneDb.on('error', console.error.bind(console, 'Fortune MongoDB connection error:'));
    fortuneDb.once('open', () => console.log('Fortune MongoDB connected'));
  }
};

module.exports = { get mainDb() { return mainDb; }, get fortuneDb() { return fortuneDb; }, startDbConnections };