const fs = require('fs');
const channels = require('../services/channel/channel.service');
const story = require('../services/channel/story.service');
const gemini = require('../services/tiktok/gemini');
const IgAccount = require('../models/IgAccount');
const ChannelVideo = require('../models/ChannelVideo');

function fail(res, err, message) {
  console.error(message + ':', err.message);
  res.status(err.status || 500).json({ message, error: String(err.message).slice(0, 500) });
}

// Hikaye modundaki hesaplarda panelde "sıradaki bölüm" gösterilir
async function accountView(account) {
  const view = IgAccount.view(account);
  if (!account.story) return view;
  const next = await story.nextEpisode(account);
  return { ...view, story_next: { season: next.season, episode: next.episode, total: next.total } };
}

exports.listAccounts = async (req, res) => {
  try {
    res.json(await Promise.all((await IgAccount.list()).map(accountView)));
  } catch (err) {
    fail(res, err, 'Hesaplar alınamadı');
  }
};

exports.addAccount = async (req, res) => {
  const accessToken = String(req.body.accessToken || '').trim();
  if (!accessToken) return res.status(400).json({ message: 'Erişim token\'ı gerekli.' });
  try {
    res.status(201).json(IgAccount.view(await channels.addAccount({ accessToken, postTimes: req.body.postTimes })));
  } catch (err) {
    fail(res, err, 'Hesap eklenemedi');
  }
};

exports.updateAccount = async (req, res) => {
  try {
    res.json(await accountView(await channels.updateAccount(Number(req.params.id), req.body || {})));
  } catch (err) {
    fail(res, err, 'Hesap güncellenemedi');
  }
};

// Karakter görselleri arka planda üretilir (karakter başına ~30 sn); panel hesabı tekrar çekerek durumu görür
exports.generateCastImages = async (req, res) => {
  try {
    res.status(202).json(await accountView(await story.generateCastImages(Number(req.params.id), { all: req.body?.all === true })));
  } catch (err) {
    fail(res, err, 'Karakter görselleri üretilemedi');
  }
};

exports.castImage = async (req, res) => {
  try {
    const account = await IgAccount.findById(Number(req.params.id));
    const image = account?.story_cast[Number(req.params.index)]?.image;
    if (!image) return res.status(404).json({ message: 'Görsel yok.' });
    res.sendFile(story.castPath(image), { headers: { 'Content-Type': story.mimeOf(image) } });
  } catch (err) {
    fail(res, err, 'Görsel alınamadı');
  }
};

exports.resetStory = async (req, res) => {
  try {
    res.json(await accountView(await channels.resetStory(Number(req.params.id))));
  } catch (err) {
    fail(res, err, 'Yeni sezon başlatılamadı');
  }
};

exports.removeAccount = async (req, res) => {
  try {
    if (!(await channels.removeAccount(Number(req.params.id)))) return res.status(404).json({ message: 'Hesap bulunamadı.' });
    res.json({ message: 'Hesap silindi.' });
  } catch (err) {
    fail(res, err, 'Hesap silinemedi');
  }
};

// Google aramalı araştırma + öneri; 30-60 sn sürebilir
exports.suggestNiches = async (req, res) => {
  try {
    res.json(await gemini.suggestNiches({ hint: String(req.body?.hint || '').slice(0, 200) }));
  } catch (err) {
    fail(res, err, 'Niş önerileri alınamadı');
  }
};

exports.generateNow = async (req, res) => {
  try {
    const account = await IgAccount.findById(Number(req.params.id));
    if (!account) return res.status(404).json({ message: 'Hesap bulunamadı.' });
    res.status(201).json(await channels.generate(account, `manual-${Date.now()}`));
  } catch (err) {
    fail(res, err, 'Video üretimi başlatılamadı');
  }
};

exports.listVideos = async (req, res) => {
  try {
    res.json(await ChannelVideo.list({ accountId: Number(req.query.accountId) || null, limit: 40 }));
  } catch (err) {
    fail(res, err, 'Videolar alınamadı');
  }
};

exports.publish = async (req, res) => {
  try {
    await channels.publish(Number(req.params.id));
    res.status(202).json({ message: 'Instagram\'a yükleniyor; bitince Telegram\'a bildirim gelir.' });
  } catch (err) {
    fail(res, err, 'Paylaşılamadı');
  }
};

exports.skip = async (req, res) => {
  try {
    await channels.skip(Number(req.params.id));
    res.json({ message: 'Atlandı.' });
  } catch (err) {
    fail(res, err, 'Atlanamadı');
  }
};

exports.videoFile = async (req, res) => {
  try {
    const video = await ChannelVideo.findById(Number(req.params.id));
    if (!video?.file_path) return res.status(404).json({ message: 'Dosya yok (henüz hazır değil, atlandı ya da 14 günü geçti).' });
    const file = channels.filePath(video.file_path);
    if (!fs.existsSync(file)) return res.status(404).json({ message: 'Dosya bulunamadı.' });
    res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' } });
  } catch (err) {
    fail(res, err, 'Dosya alınamadı');
  }
};

exports.removeVideo = async (req, res) => {
  try {
    if (!(await channels.removeVideo(Number(req.params.id)))) return res.status(404).json({ message: 'Video bulunamadı.' });
    res.json({ message: 'Video silindi.' });
  } catch (err) {
    fail(res, err, 'Video silinemedi');
  }
};
