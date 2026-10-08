const router = require('express').Router();
const auth = require('../middleware/auth');
const channelController = require('../controllers/channel.controller');

router.get('/accounts', auth, channelController.listAccounts);
router.post('/accounts', auth, channelController.addAccount);
router.patch('/accounts/:id', auth, channelController.updateAccount);
router.delete('/accounts/:id', auth, channelController.removeAccount);
router.post('/accounts/:id/generate', auth, channelController.generateNow);
router.post('/niches/suggest', auth, channelController.suggestNiches);
router.get('/videos', auth, channelController.listVideos);
router.post('/videos/:id/publish', auth, channelController.publish);
router.post('/videos/:id/skip', auth, channelController.skip);
router.get('/videos/:id/file', auth, channelController.videoFile);
router.delete('/videos/:id', auth, channelController.removeVideo);

module.exports = router;
