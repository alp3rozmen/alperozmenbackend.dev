const express = require('express');
const fs = require('fs/promises');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const auth = require('../middleware/auth');

const router = express.Router();
const client = new IgApiClient();
let loggedUser = null;

async function TwoFactorLogin(options) {
  console.log(options);
  try {
    loggedUser = await client.account.twoFactorLogin(options)
  } catch (e) {    
    throw new Error("Api Hatası : " + e.message);
  }
}

async function LoginFnc(pUserName, pPassword) {
  client.state.generateDevice(pUserName);
  try {
    loggedUser = await client.account.login(pUserName, pPassword);
  } catch (e) {
    if (e instanceof IgLoginTwoFactorRequiredError) {
      throw new Error("TwoFactor");
    }
    else{
      throw new Error("Api Hatası : " + e.message);
    }
  }
}

// 🔹 Login endpoint
router.post('/login', auth, async (req, res) => {
  const { userName, password } = req.body;

  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  try {
    await LoginFnc(userName, password);
    if (loggedUser?.username) {
      return res.status(200).json({ message: 'Giriş Başarılı' , code : 'OK' });
    }
    else{
      return res.status(200).json({ message: 'Giriş Başarısız' });
    }
  } catch (error) {
    if (error.message == "TwoFactor") {
      return res.status(403).json({message : 'TwoFactorNeeded'});
    }
    else{
      return res.status(403).json({message : error.message});
    }
  }
});

router.post('/2flogin', auth, async (req, res) => {
  const { pverificationCode, ptwoFactorIdentifier, pusername,pver, pverificationMethod } = req.body;

  if (!pusername) {
    return res.status(400).json({ message: 'Kullanıcı adı gerekli!' });
  }

  try {
    loggedUser =await TwoFactorLogin({
      verificationCode: pverificationCode,  
      twoFactorIdentifier : ptwoFactorIdentifier,
      username : pusername,
      trustThisDevice : '1',
      verificationMethod : pverificationMethod
    })

    if (loggedUser?.username) {
      return res.status(200).json({ message: 'Giriş Başarılı' , code : 'OK' });
    }
    else{
      return res.status(400).json({ message: loggedUser });
    }
  } catch (error) {
    return res.status(400).json(error.message);
  }
});

// 🔹 Video paylaşma endpoint
router.post('/add', auth, async (req, res) => {
  const { caption, videoPath, coverImagePath, userName, password } = req.body;
  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  try {
    if (!loggedUser?.username) {
      return res.status(401).json({
        message: '❌ Giriş başarısız, video yüklenmedi.',
      });
    }

    const bufferVideo = await fs.readFile(videoPath);
    const bufferCoverImage = await fs.readFile(coverImagePath);

    await client..publish.video({
      video: bufferVideo,
      coverImage: bufferCoverImage,
      caption,
    });

    return res.status(201).json({
      message: '✅ Video başarıyla paylaşıldı!',
    });
  } catch (err) {
    console.error('Instagram paylaşım hatası:', err);
    return res.status(500).json({
      message: 'Instagram paylaşımı başarısız.',
      error: err.message,
    });
  }
});

module.exports = router;
