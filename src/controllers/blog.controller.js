const Blog = require('../models/Blog');
const crudController = require('./crud.controller');

module.exports = crudController(Blog, ['title', 'content', 'author'], 'Blog');
