const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  credits: { type: Number, default: 0 },       // <--- kredi sayısını burada tutuyoruz
  createdAt: { type: Date, default: Date.now },
  lastFalAt: Date ,
  isFollowChannel: Boolean,
  isProcessing : Boolean,
  refCode : String,
  isUsedRefCode : Boolean                             // opsiyonel: son fal zamanı (rate-limit için)
});

module.exports = mongoose.model("TelveciAIUser", userSchema);
