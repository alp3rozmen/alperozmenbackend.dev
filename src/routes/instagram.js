const express = require('express');
const fs = require('fs/promises');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const auth = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

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


router.post('/add', auth, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), async (req, res) => {
  
  if (!loggedUser?.username) {
    return res.status(401).json({ message: '❌ Giriş başarısız, video yüklenmedi.' });
  }

  const { caption } = req.body;
  const videoBuffer = req.files.video[0].buffer;
  const coverBuffer = req.files.cover[0].buffer;

  try {
    await client.publish.video({
      video: videoBuffer,
      coverImage: coverBuffer,
      caption,
    });  
  } catch (error) {
    return res.json({ message: 'Hata Video Paylaşılamadı! ' +  error.message});  
  }
  
  return res.json({ message: '✅ Video başarıyla paylaşıldı!' });
});


// 🔹 Video paylaşma endpoint
router.post('/add', auth, async (req, res) => {
  const { caption, videoBase64, coverBase64, userName, password } = req.body;

  if (!userName || !password) {
    return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });
  }

  try {
    if (!loggedUser?.username) {
      return res.status(401).json({ message: '❌ Giriş başarısız, video yüklenmedi.' });
    }

    const bufferVideo = Buffer.from(videoBase64, 'base64');
    const bufferCoverImage = coverBase64 ? Buffer.from(coverBase64, 'base64') : null;

    await client.publish.video({
      video: bufferVideo,
      coverImage: bufferCoverImage,
      caption,
    });

    return res.status(201).json({ message: '✅ Paylaşıldı' });
  } catch (err) {
    console.error('Instagram paylaşım hatası:', err);
    return res.status(500).json({
      message: 'Instagram paylaşımı başarısız.',
      error: err.message,
    });
  }
});



module.exports = router;
