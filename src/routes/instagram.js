const express = require('express');
const fs = require('fs/promises');
const { IgApiClient } = require('instagram-private-api');
const auth = require('../middleware/auth');

const router = express.Router();

// 🔹 Login endpoint
router.post('/login', auth, async (req, res) => {
  const { userName, password } = req.body;

  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  try {
    const ig = new IgApiClient();
    ig.state.generateDevice(userName);

    const loggedInUser = await ig.account.login(userName, password);

    if (loggedInUser?.username) {
      return res.status(200).json({ message: '✅ Giriş başarılı.', user: loggedInUser.username });
    }

    return res.status(401).json({ message: '❌ Giriş başarısız.' });
  } catch (err) {
    console.error('Login hatası:', err);
    return res.status(500).json({ message: 'Login başarısız.', error: err.message });
  }
});

// 🔹 Video paylaşma endpoint
router.post('/add', auth, async (req, res) => {
  const { caption, videoPath, coverImagePath, userName, password } = req.body;

  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  try {
    const ig = new IgApiClient();
    ig.state.generateDevice(userName);

    // Önce login denemesi
    const loggedInUser = await ig.account.login(userName, password);

    if (!loggedInUser?.username) {
      return res.status(401).json({ message: '❌ Giriş başarısız, video yüklenmedi.' });
    }

    // ✅ Login başarılıysa video yükle
    let bufferVideo = await fs.readFile(videoPath);
    let bufferCoverImage = await fs.readFile(coverImagePath);

    await ig.publish.video({
      video: bufferVideo,
      coverImage: bufferCoverImage,
      caption: caption,
    });

    return res.status(201).json({ message: '✅ Video başarıyla paylaşıldı!' });
  } catch (err) {
    console.error('Instagram paylaşım hatası:', err);
    return res.status(500).json({ message: 'Instagram paylaşımı başarısız.', error: err.message });
  }
});

module.exports = router;
