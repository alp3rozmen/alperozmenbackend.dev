const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  author: { type: String, required: true },
}, { timestamps: true });

module.exports = (conn) => conn.model('Blog', blogSchema);
