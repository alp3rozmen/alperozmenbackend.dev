const express = require('express');
const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const multer = require('multer');
const auth = require('../middleware/auth');
const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream');
const os = require('os');
const path = require('path');
const fs = require('fs');

function transcodeForInstagram(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `ig_in_${Date.now()}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `ig_out_${Date.now()}.mp4`);
    fs.writeFileSync(tmpIn, inputBuffer);
    ffmpeg(tmpIn)
      .videoCodec('libx264')
      .outputOptions([
        '-profile:v high',
        '-level 4.0',
        '-vf scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-pix_fmt yuv420p',
        '-r 30',
        '-b:v 3500k',
        '-movflags +faststart',
      ])
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioFrequency(44100)
      .save(tmpOut)
      .on('end', () => {
        const buf = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
        resolve(buf);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(tmpIn); } catch (_) {}
        try { fs.unlinkSync(tmpOut); } catch (_) {}
        reject(err);
      });
  });
}

const router = express.Router();
const client = new IgApiClient();
const SESSION_FILE = path.join(os.tmpdir(), 'ig_session_state.json');

// Memory storage, küçük/orta boy videolar için
const upload = multer({ storage: multer.memoryStorage() });

async function saveSession() {
  try {
    const state = await client.state.serialize();
    delete state.constants;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
    console.log('Session kaydedildi.');
  } catch (e) {
    console.error('Session kaydedilemedi:', e.message);
  }
}

async function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      await client.state.deserialize(state);
      console.log('Session yüklendi.');
      return true;
    }
  } catch (e) {
    console.error('Session yüklenemedi:', e.message);
  }
  return false;
}

// 🔹 Login fonksiyonu
async function LoginFnc(username, password) {
  client.state.generateDevice(username);
  try {
    const loggedUser = await client.account.login(username, password);
    await saveSession();
    console.log('Giriş yapıldı:', loggedUser.username);
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
  let kayitliSession = false;
  if (!req.files || !req.files.video || !req.files.cover) {
    return res.status(400).json({ message: 'Video ve cover gerekli!' });
  }

  if (!pusername || !ppassword) {
    return res.status(400).json({ message: 'pusername ve ppassword gerekli!' });
  }

  const rawVideoBuffer = req.files.video[0].buffer;
  const coverBuffer = req.files.cover[0].buffer;

  try {
    // Önce kayıtlı session'ı dene, yoksa login yap
    const sessionLoaded = await loadSession();
    if (!sessionLoaded) {
      console.log(`Session bulunamadı, login yapılıyor: ${pusername}`);
      await LoginFnc(pusername, ppassword);
      console.log('Login başarılı.');
    } else {
      console.log('Kayıtlı session kullanılıyor.');
      kayitliSession = true;
    }

    console.log('Transcode ediliyor...');
    const videoBuffer = await transcodeForInstagram(rawVideoBuffer);
    console.log('Transcode tamamlandı, Instagram\'a yükleniyor...');

    const response = await client.publish.video({
      video: videoBuffer,
      coverImage: coverBuffer,
      caption,
      transcodeDelay: 10000,
    });

    if (!response.upload_id){
      console.error('Video paylaşım hatası:', response);
      return res.status(400).json({ message: response, code: 'ERROR' });
    }
    console.log('Video paylaşım başarılı:', response);
    return res.status(201).json({ message: 'Video Paylaşıldı', code: 'OK' });
  } catch (error) {
    // Session geçersizse sil, sonraki istekte tekrar login yapar
    if (fs.existsSync(SESSION_FILE) && (!kayitliSession)) {
      fs.unlinkSync(SESSION_FILE);
      console.log('Session silindi, sonraki istekte yeniden login yapılacak.');
    }
    console.error('Video paylaşım hatası:', error);
    return res.status(400).json({ message: 'Hata Video Paylaşılamadı: ' + error.message });
  }
});

module.exports = router;
