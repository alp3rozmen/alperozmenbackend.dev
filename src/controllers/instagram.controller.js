const instagramService = require('../services/instagram.service');

exports.login = async (req, res) => {
  const { userName, password } = req.body;
  if (!userName || !password) return res.status(400).json({ message: 'Kullanıcı adı ve şifre gerekli.' });

  try {
    const result = await instagramService.LoginFnc(userName, password);

    if (result.twoFactorRequired) {
      return res.status(403).json({ twoFactorIdentity: result.twoFactorInfo.two_factor_identifier, code: 'TwoFactorNeeded' });
    }

    return res.status(200).json({ message: 'Giriş Başarılı', code: 'OK' });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

exports.twoFactorLogin = async (req, res) => {
  const { pverificationCode, ptwoFactorIdentifier, pusername, pverificationMethod } = req.body;
  if (!pusername) return res.status(400).json({ message: 'Kullanıcı adı gerekli!' });

  try {
    const result = await instagramService.TwoFactorLogin({
      verificationCode: pverificationCode,
      twoFactorIdentifier: ptwoFactorIdentifier,
      username: pusername,
      verificationMethod: pverificationMethod
    });

    return res.status(200).json({ message: 'Giriş Başarılı', code: 'OK', username: result.username });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

exports.addVideo = async (req, res) => {
  const { caption, pusername, ppassword } = req.body;
  let kayitliSession = false;
  if (!req.files || !req.files.video || !req.files.cover) {
    return res.status(400).json({ message: 'Video ve cover gerekli!' });
  }

  if (!pusername || !ppassword) {
    return res.status(400).json({ message: 'pusername ve ppassword gerekli!' });
  }

  try {
    kayitliSession = await instagramService.ensureLoggedIn(pusername, ppassword);

    const response = await instagramService.publishVideo({
      rawVideoBuffer: req.files.video[0].buffer,
      coverBuffer: req.files.cover[0].buffer,
      caption
    });

    if (!response.upload_id) {
      console.error('Video paylaşım hatası:', response);
      return res.status(400).json({ message: response, code: 'ERROR' });
    }
    console.log('Video paylaşım başarılı:', response);
    return res.status(201).json({ message: 'Video Paylaşıldı', code: 'OK' });
  } catch (error) {
    if (!kayitliSession) instagramService.clearSession();
    console.error('Video paylaşım hatası:', error);
    return res.status(400).json({ message: 'Hata Video Paylaşılamadı: ' + error.message });
  }
};
