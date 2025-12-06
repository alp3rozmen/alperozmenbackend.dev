const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  credits: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastFalAt: Date,
  isFollowChannel: Boolean,
  isProcessing: Boolean,
  refCode: { type: String, unique: true, sparse: true },
  isUsedRefCode: Boolean,
});

module.exports = (conn) => conn.model("TelveciAIUser", userSchema);
