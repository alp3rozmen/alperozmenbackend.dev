const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const kie = require('./kie.api');
const instagram = require('../instagram.graph');

// Diskteki videoyu Instagram Reels olarak paylaşır; medya id'sini döner.
// Site bot korumasının arkasında (Instagram'ın indiricisi doğrulama sayfasına takılır); video bu yüzden
// kie.ai'nin herkese açık deposuna yüklenip oradan verilir (24 saat tutulur).
async function publishFile({ file, caption, account, name }) {
  // Edit list kalmış render'larda Instagram işleme hatası veriyordu; yeniden kodlamadan temiz kopya çıkar
  const clean = path.join(os.tmpdir(), `${name}-ig-${Date.now()}.mp4`);
  try {
    await ffmpeg.run(['-i', file, '-c', 'copy', '-movflags', '+faststart', '-use_editlist', '0', clean]);
    const videoUrl = await kie.uploadFile(clean, 'video/mp4', `${name}.mp4`);
    return await instagram.publishReel({ videoUrl, caption, account });
  } finally {
    await fs.promises.unlink(clean).catch(() => {});
  }
}

module.exports = { publishFile };
