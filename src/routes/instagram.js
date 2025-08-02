const express = require('express');
const fs = require('fs/promises'); // ✅ async fs modülü
const auth = require('../middleware/auth');

const router = express.Router();

let ig;

(async () => {
  const { IgApiClient } = await import('instagram-private-api');
  ig = new IgApiClient();
  ig.state.generateDevice('scriptwhiz');
})();

router.post('/add', auth, async (req, res) => {
  try {
    const { caption, videoPath, coverImagePath, userName, password } = req.body;
      
    if (!ig) {
      return res.status(500).json({ message: 'Instagram API hazır değil.' });
    }

    // Giriş yap
    const loggedInUser = await ig.account.login(userName, password);

    // ✅ Giriş başarılıysa
    if (loggedInUser?.username) {

      let bufferVideo = await fs.readFile(videoPath);
      let bufferCoverImage = await fs.readFile(coverImagePath);

      const uploadedPhoto = await ig.publish.video({
        video: bufferVideo,
        coverImage: bufferCoverImage,
        caption: caption,
      });

      return res.status(201).json({ message: '✅ Paylaşıldı!' });
    }

    return res.status(401).json({ message: '❌ Giriş başarısız.' });

  } catch (err) {
    console.error('Instagram paylaşım hatası:', err);
    return res.status(500).json({ message: 'Instagram paylaşımı başarısız.', error: err.message });
  }
});

module.exports = router;