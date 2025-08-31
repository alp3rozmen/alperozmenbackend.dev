const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  acPrice: { type: Number },
  acDiscount: { type: Number, required: true },
  dc30Price: { type: Number, default: null },
  dc30Discount: { type: Number, default: null },
  dc60Price: { type: Number, default: null },
  dc60Discount: { type: Number, default: null },
  dc120Price: { type: Number, default: null },
  dc120Discount: { type: Number, default: null },
  dc180Price: { type: Number, required: true },
  dc180Discount: { type: Number, required: true },
  dcOver180Price: { type: Number, required: true },
  dcOver180Discount: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('campaings', campaignSchema);
