const crud = require('./crud');
const { db } = require('../config/db');

module.exports = crud(db, 'blogs', ['title', 'content', 'author']);
