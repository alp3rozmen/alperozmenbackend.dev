const mongoose = require('mongoose');

const carsSchema = new mongoose.Schema({
  brand: { type: String, required: true },
  battery: { type: String, required: true }
}, { timestamps: true });

module.exports = (conn) => conn.model('Cars', carsSchema, 'cars');
