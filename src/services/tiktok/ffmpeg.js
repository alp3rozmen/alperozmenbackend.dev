const { spawn } = require('child_process');
// cPanel'de sistem ffmpeg'i olmayabileceği için npm ile gelen statik binary kullanılır
const FFMPEG = require('ffmpeg-static');

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000); // hata ayıklamak için son kısım yeter
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg hata kodu ${code}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

// ffprobe statik pakette yok; `ffmpeg -i` çıktısından süre ve ses akışı okunur
function probe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', () => {
      const m = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m || !/Stream #.*Video:/.test(stderr)) return reject(new Error('Video dosyası okunamadı'));
      resolve({
        duration: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
        hasAudio: /Stream #.*Audio:/.test(stderr),
      });
    });
  });
}

module.exports = { run, probe };
