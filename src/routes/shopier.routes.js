const router = require('express').Router();
const auth = require('../middleware/auth');
const controller = require('../controllers/shopier.controller');

router.get('/status', auth, controller.status);
router.get('/oauth/url', auth, controller.oauthUrl);
router.post('/oauth/exchange', auth, controller.oauthExchange);
router.post('/disconnect', auth, controller.disconnect);
router.get('/products', auth, controller.products);
router.get('/batches', auth, controller.listBatches);
router.post('/batches', auth, controller.createBatch);
router.get('/batches/:id', auth, controller.getBatch);
router.post('/batches/:id/revert', auth, controller.revertBatch);

module.exports = router;
