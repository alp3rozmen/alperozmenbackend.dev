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
  { name: 'video' },
  { name: 'cover' }
]), async (req, res) => {
  
  if (!loggedUser?.username) {
    return res.status(401).json({ message: '❌ Giriş başarısız, video yüklenmedi.' });
  }

  const { caption } = req.body;
  const videoBuffer = req.files.video[0].buffer;
  const coverBuffer = req.files.cover[0].buffer;

  console.log(videoBuffer);
  console.log(coverBuffer);
 
  try {
    var response = await client.publish.video({
      video: videoBuffer,
      coverImage: coverBuffer,
      caption,
    });  

    if (!response.upload_id) {
      return res.status(400).json({ message: response, code : 'ERROR'   });  
    }

    return res.status(201).json({ message: 'Video Paylaşıldı', code : 'OK'  });

  } catch (error) {
    return res.status(400).json({ message: 'Hata Video Paylaşılamadı! ' +  error.message});  
  }
  
  
});


module.exports = router;
