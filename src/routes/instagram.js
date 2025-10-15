const express = require('express');
const fs = require('fs/promises');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const auth = require('../middleware/auth');

const router = express.Router();

// Bellekte IG instance saklıyoruz (daha iyi yöntem: DB/cache ile user bazlı saklamak)
let igInstances = {};

// 🔹 Login endpoint
router.post('/login', auth, async (req, res) => {
  const { userName, password } = req.body;

  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  const ig = new IgApiClient();
  ig.state.generateDevice(userName);
  igInstances[userName] = { ig, type: 'login' };
  try {
    const loggedInUser = await ig.account.login(userName, password);

    if (loggedInUser?.username) {
      return res.status(200).json({
        message: '✅ Giriş başarılı.',
        user: loggedInUser.username,
      });
    }

    return res.status(401).json({ message: '❌ Giriş başarısız.' });
  } catch (err) {
    
    if (err instanceof IgLoginTwoFactorRequiredError) {
      igInstances[userName] = { ig, type: 'two_factor', info: err.twoFactorInfo };
      return res.status(403).json({
        message:  err.message +'⚠️ 2FA gerekli. Kullanıcıya kod sorulmalı.',
        type: 'two_factor',
        two_factor_info: err.twoFactorInfo,
      });
    }

    console.error('Login hatası:', err);
    return res.status(500).json({
      message: 'Login başarısız.',
      error: err.message,
    });
  }
});

// 🔹 2FA çözme endpoint
router.post('/login/2fa', auth, async (req, res) => {
  const { userName, code } = req.body;

  if (!userName || !code) {
    return res.status(400).json({ message: 'Kullanıcı adı ve doğrulama kodu gerekli.' });
  }

  try {
    const userSession = igInstances[userName];
    if (!userSession || userSession.type !== 'two_factor') {
      return res.status(400).json({ message: 'Önce /login ile 2FA başlatılmalı.' });
    }

    const { ig, info } = userSession;

    const result = await ig.account.twoFactorLogin({
      verificationCode: code,
      twoFactorIdentifier: "whatshapp",
      username: userName,
      trustThisDevice: '1',
      verificationMethod: '1', // 1 = SMS, 0 = Authenticator
    });

    if (result?.username) {
      delete igInstances[userName];
      return res.status(200).json({
        message: '✅ 2FA çözüldü, giriş başarılı.',
        user: result.username,
      });
    }

    return res.status(401).json({
      message: '❌ Yanlış 2FA kodu veya giriş başarısız.',
      result,
    });
  } catch (err) {
    console.error('2FA çözme hatası:', err);
    return res.status(500).json({
      message: '2FA çözme başarısız.',
      error: err.message,
    });
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

    const loggedInUser = await ig.account.login(userName, password);

    if (!loggedInUser?.username) {
      return res.status(401).json({
        message: '❌ Giriş başarısız, video yüklenmedi.',
      });
    }

    const bufferVideo = await fs.readFile(videoPath);
    const bufferCoverImage = await fs.readFile(coverImagePath);

    await ig.publish.video({
      video: bufferVideo,
      coverImage: bufferCoverImage,
      caption,
    });

    return res.status(201).json({
      message: '✅ Video başarıyla paylaşıldı!',
    });
  } catch (err) {
    if (err.error && err.error.message === 'challenge_required') {
      return res.status(403).json({
        message: '⚠️ Challenge gerekli, video yüklenemedi.',
        challenge: err.error.challenge,
      });
    }

    if (err.error && err.error.message === 'two_factor_required') {
      return res.status(403).json({
        message: '⚠️ 2FA gerekli, video yüklenemedi.',
        two_factor_info: err.error.two_factor_info,
      });
    }

    console.error('Instagram paylaşım hatası:', err);
    return res.status(500).json({
      message: 'Instagram paylaşımı başarısız.',
      error: err.message,
    });
  }
});

module.exports = router;
