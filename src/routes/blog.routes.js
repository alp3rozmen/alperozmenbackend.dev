const router = require('express').Router();
const auth = require('../middleware/auth');
const blogController = require('../controllers/blog.controller');

router.get('/', blogController.list);
router.post('/add', auth, blogController.create);
router.get('/:id', blogController.getById);
router.put('/:id', auth, blogController.update);
router.delete('/:id', auth, blogController.remove);

module.exports = router;
