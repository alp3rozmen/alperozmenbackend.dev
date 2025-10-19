const express = require('express');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const multer = require('multer');
const auth = require('../middleware/auth');

const router = express.Router();
const client = new IgApiClient();

// Memory storage, küçük/orta boy videolar için
const upload = multer({ storage: multer.memoryStorage() });

// 🔹 Login fonksiyonu
async function LoginFnc(username, password) {
  client.state.generateDevice(username);
  try {
    const loggedUser = await client.account.login(username, password);
    return loggedUser;
  } catch (e) {
    if (e instanceof IgLoginTwoFactorRequiredError) {
      return { twoFactorRequired: true, twoFactorInfo: e.response.body.two_factor_info };
    }
    throw e;
  }
}

// 🔹 TwoFactor Login
async function TwoFactorLogin({ verificationCode, twoFactorIdentifier, username, verificationMethod }) {
  try {
    const loggedUser = await client.account.twoFactorLogin({
      username,
      verificationCode,
      twoFactorIdentifier,
      trustThisDevice: '1',
      verificationMethod
    });
    return loggedUser;
  } catch (e) {
    throw new Error('2FA Hatası: ' + e.message);
  }
}

// 🔹 Login endpoint (auth yok)
router.post('/login', async (req, res) => {
  const { userName, password } = req.body;
  if (!userName || !password) return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });

  try {
    const result = await LoginFnc(userName, password);

    if (result.twoFactorRequired) {
      return res.status(403).json({ twoFactorIdentity: result.twoFactorInfo.two_factor_identifier, code: 'TwoFactorNeeded' });
    }

    return res.status(200).json({ message: 'Giriş Başarılı', code: 'OK' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// 🔹 2FA endpoint
router.post('/2flogin', async (req, res) => {
  const { pverificationCode, ptwoFactorIdentifier, pusername, pverificationMethod } = req.body;
  if (!pusername) return res.status(400).json({ message: 'Kullanıcı adı gerekli!' });

  try {
    const result = await TwoFactorLogin({
      verificationCode: pverificationCode,
      twoFactorIdentifier: ptwoFactorIdentifier,
      username: pusername,
      verificationMethod: pverificationMethod
    });

    return res.status(200).json({ message: 'Giriş Başarılı', code: 'OK', username: result.username });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// 🔹 Video paylaşım endpoint (auth gerekli)
router.post('/add', auth, upload.fields([
  { name: 'video' },
  { name: 'cover' }
]), async (req, res) => {
  const { caption, pusername, ppassword } = req.body;
  let loggedUser;

  // Kullanıcı giriş yapmamışsa login ol
  try {
    loggedUser = await LoginFnc(pusername, ppassword);
    if (loggedUser.twoFactorRequired) {
      return res.status(403).json({ message: '2FA gerekli', code: 'TwoFactorNeeded' });
    }
  } catch (error) {
    return res.status(400).json({ message: 'Giriş Başarısız: ' + error.message });
  }

  if (!req.files || !req.files.video || !req.files.cover) {
    return res.status(400).json({ message: 'Video ve cover gerekli!' });
  }

  const videoBuffer = req.files.video[0].buffer;
  const coverBuffer = req.files.cover[0].buffer;

  try {
    const response = await client.publish.video({
      video: videoBuffer,
      coverImage: coverBuffer,
      caption,
    });

    if (!response.upload_id) return res.status(400).json({ message: response, code: 'ERROR' });

    return res.status(201).json({ message: 'Video Paylaşıldı', code: 'OK' });
  } catch (error) {
    return res.status(400).json({ message: 'Hata Video Paylaşılamadı: ' + error.message });
  }
});

module.exports = router;
