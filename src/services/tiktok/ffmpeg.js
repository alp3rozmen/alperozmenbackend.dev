const { spawn } = require('child_process');
// cPanel'de sistem ffmpeg'i olmayabileceği için npm ile gelen statik binary kullanılır
const FFMPEG = require('ffmpeg-static');

// Paylaşımlı hostingde (CloudLinux) işlem/thread sınırı var; ffmpeg varsayılan olarak çekirdek sayısı kadar
// thread açar ve sınıra takılınca x264 başlatılamaz ("Conversion failed", kod 187). Thread'ler sınırlanır.
const THREADS = '2';

// Son argüman her zaman çıktı dosyası; -threads çıktı (kodlayıcı) seçeneği olduğu için ondan hemen önce eklenir
function run(args) {
  const fullArgs = [
    '-hide_banner', '-y', '-filter_threads', THREADS, '-filter_complex_threads', THREADS,
    ...args.slice(0, -1), '-threads', THREADS, args[args.length - 1],
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, fullArgs);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000); // hata ayıklamak için son kısım yeter
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve(stderr);
      console.error(`ffmpeg hata kodu ${code}\nKomut: ${fullArgs.join(' ')}\n${stderr}`);
      // Asıl sebep genelde sondaki özet satırlarında değil, "Error"/"failed" içeren satırlardadır
      const lines = stderr.split('\n').filter(Boolean);
      const cause = lines.filter((l) => /error|failed|invalid|cannot|unable/i.test(l) && !/Conversion failed/.test(l)).slice(-3);
      reject(new Error(`ffmpeg hata kodu ${code}: ${(cause.length ? cause : lines.slice(-3)).join(' | ')}`));
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
