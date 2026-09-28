const { IgApiClient, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const ffmpeg = require('fluent-ffmpeg');
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

const client = new IgApiClient();
const SESSION_FILE = path.join(os.tmpdir(), 'ig_session_state.json');

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

// Kayıtlı session varsa onu kullanır, yoksa login olur.
// Dönüş: true => kayıtlı session kullanıldı
async function ensureLoggedIn(username, password) {
  const sessionLoaded = await loadSession();
  if (sessionLoaded) {
    console.log('Kayıtlı session kullanılıyor.');
    return true;
  }
  console.log(`Session bulunamadı, login yapılıyor: ${username}`);
  await LoginFnc(username, password);
  console.log('Login başarılı.');
  return false;
}

// Session geçersizse sil, sonraki istekte tekrar login yapar
function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log('Session silindi, sonraki istekte yeniden login yapılacak.');
  }
}

async function publishVideo({ rawVideoBuffer, coverBuffer, caption }) {
  console.log('Transcode ediliyor...');
  const videoBuffer = await transcodeForInstagram(rawVideoBuffer);
  console.log('Transcode tamamlandı, Instagram\'a yükleniyor...');

  return client.publish.video({
    video: videoBuffer,
    coverImage: coverBuffer,
    caption,
    transcodeDelay: 10000,
  });
}

module.exports = { LoginFnc, TwoFactorLogin, ensureLoggedIn, clearSession, publishVideo };
