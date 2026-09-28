const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  age: { type: Number, required: true },
  gender: { type: String, required: true },
  imageCup: { type: String, required: true },
  imageCup2: { type: String, required: true },
  imageCup3: { type: String, required: true },
  email: { type: String, required: true },
  maritalStatus: { type: String, required: true },
  lookingFor: { type: String, required: true },
  isLooked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = (conn) => conn.model('fortunes', userSchema);
