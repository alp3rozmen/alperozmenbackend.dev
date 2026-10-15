-- cPanel > phpMyAdmin'de soldan onur6417_alperozmen_main veritabanını seç,
-- sonra SQL sekmesine yapıştırıp çalıştır.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blogs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content LONGTEXT NOT NULL,
  author VARCHAR(100) NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kripto sinyal botu: üretilen AL sinyalleri ve sanal pozisyon takibi
CREATE TABLE IF NOT EXISTS crypto_signals (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  pair VARCHAR(40) NOT NULL,
  entry_price DECIMAL(30,12) NOT NULL,
  tp_price DECIMAL(30,12) NOT NULL,
  sl_price DECIMAL(30,12) NOT NULL,
  atr DECIMAL(30,12) NOT NULL,
  rsi DECIMAL(6,2) NOT NULL,
  volume_ratio DECIMAL(10,2) NOT NULL,
  change_24h DECIMAL(10,2) NOT NULL,
  status ENUM('open','tp','sl','expired') NOT NULL DEFAULT 'open',
  exit_price DECIMAL(30,12) NULL,
  pnl_pct DECIMAL(10,3) NULL,
  max_price DECIMAL(30,12) NOT NULL,
  min_price DECIMAL(30,12) NOT NULL,
  opened_at DATETIME NOT NULL,
  checked_at DATETIME NOT NULL,
  closed_at DATETIME NULL,
  INDEX idx_status (status),
  INDEX idx_pair_opened (pair, opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tek satırlık bot durumu (id = 1): sunucu yeniden başlarsa kaldığı yerden devam eder
CREATE TABLE IF NOT EXISTS crypto_settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  running TINYINT(1) NOT NULL DEFAULT 0,
  settings TEXT NULL,
  last_scan_at DATETIME NULL,
  last_error VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin panelinden düzenlenen uygulama ayarları (Telegram vb.). Boş olanlar için .env kullanılır.
CREATE TABLE IF NOT EXISTS app_settings (
  `key` VARCHAR(100) PRIMARY KEY,
  `value` TEXT NULL,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TikTok İçerik Stüdyosu: Gemini'nin ürettiği video fikirleri
CREATE TABLE IF NOT EXISTS tiktok_ideas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(200) NOT NULL,
  notes TEXT NULL,
  research TEXT NULL,
  ideas MEDIUMTEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- kie.ai ile üretilen hook klipleri; dosyalar storage/tiktok altında, 14 gün sonra silinir
CREATE TABLE IF NOT EXISTS tiktok_videos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  idea_id INT UNSIGNED NULL,
  idea_index TINYINT UNSIGNED NULL,
  model VARCHAR(100) NOT NULL,
  prompt TEXT NOT NULL,
  duration TINYINT UNSIGNED NOT NULL,
  resolution VARCHAR(10) NOT NULL,
  kie_task_id VARCHAR(100) NULL,
  status ENUM('pending','success','fail') NOT NULL DEFAULT 'pending',
  credits DECIMAL(10,2) NULL,
  source_url TEXT NULL,
  file_path VARCHAR(255) NULL,
  error VARCHAR(500) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt DATETIME NULL,
  INDEX idx_status (status),
  INDEX idx_idea (idea_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kullanıcının yüklediği kendi çekimleri (timelapse vb.); storage/tiktok/clips altında
CREATE TABLE IF NOT EXISTS tiktok_clips (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  idea_id INT UNSIGNED NOT NULL,
  idea_index TINYINT UNSIGNED NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NULL,
  duration DECIMAL(8,2) NOT NULL,
  has_audio TINYINT(1) NOT NULL DEFAULT 0,
  target_seconds DECIMAL(4,1) NOT NULL DEFAULT 4,
  sort_order INT NOT NULL DEFAULT 0,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_idea (idea_id, idea_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hook klibi + kullanıcı klipleri + altyazılarla birleştirilmiş son videolar; storage/tiktok/renders altında
CREATE TABLE IF NOT EXISTS tiktok_renders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  idea_id INT UNSIGNED NOT NULL,
  idea_index TINYINT UNSIGNED NOT NULL,
  hook_video_id INT UNSIGNED NULL,
  status ENUM('pending','success','fail') NOT NULL DEFAULT 'pending',
  file_path VARCHAR(255) NULL,
  duration DECIMAL(8,2) NULL,
  error VARCHAR(500) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt DATETIME NULL,
  INDEX idx_idea (idea_id, idea_index),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fotoğraftan tam otomatik ürün videosu: Gemini senaryo yazar, kie.ai (Grok) sahneleri üretir, ffmpeg birleştirir.
-- Dosyalar storage/tiktok/product altında, 14 gün sonra silinir.
CREATE TABLE IF NOT EXISTS product_videos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(200) NOT NULL,
  notes TEXT NULL,
  status ENUM('planning','generating','rendering','success','fail') NOT NULL DEFAULT 'planning',
  photos TEXT NULL,
  plan MEDIUMTEXT NULL,
  scenes TEXT NULL,
  credits DECIMAL(10,2) NULL,
  file_path VARCHAR(255) NULL,
  duration DECIMAL(8,2) NULL,
  auto_publish TINYINT(1) NOT NULL DEFAULT 0,
  publish_status ENUM('none','pending','published','fail') NOT NULL DEFAULT 'none',
  publish_error VARCHAR(500) NULL,
  ig_media_id VARCHAR(64) NULL,
  error VARCHAR(500) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt DATETIME NULL,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Instagram hesapları (Instagram Login token'ı ile); her hesabın kendi nişi ve paylaşım saatleri var
CREATE TABLE IF NOT EXISTS ig_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  ig_user_id VARCHAR(64) NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  token_refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  niche VARCHAR(200) NULL,
  niche_brief TEXT NULL,
  post_times VARCHAR(100) NOT NULL DEFAULT '12:00,20:00',
  video_seconds TINYINT UNSIGNED NOT NULL DEFAULT 6,
  active TINYINT(1) NOT NULL DEFAULT 0,
  -- Ürün hesabı: sadece ürün videoları paylaşılır; niş kanalları ekranına ve otomatik üretime girmez
  is_product TINYINT(1) NOT NULL DEFAULT 0,
  -- Konuşmalı komedi: karakterler Türkçe konuşur, argo/küfür serbest (Grok "fun" modu)
  comedy TINYINT(1) NOT NULL DEFAULT 0,
  -- Hikaye modu (dizi): sabit karakterler, sezon/bölüm, merak uyandıran kapanış
  story TINYINT(1) NOT NULL DEFAULT 0,
  story_cast TEXT NULL,       -- JSON: [{ name, description, image, imageStatus, imageError }]
  story_since DATETIME NULL,  -- "Yeni sezon başlat" anı; bundan önceki bölümler hikayeye dahil edilmez
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Niş kanalları için üretilen videolar; Telegram'dan onaylanınca ilgili hesaba paylaşılır
CREATE TABLE IF NOT EXISTS channel_videos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id INT UNSIGNED NOT NULL,
  slot VARCHAR(20) NOT NULL,
  status ENUM('generating','rendering','ready','publishing','published','skipped','fail') NOT NULL DEFAULT 'generating',
  idea TEXT NULL,
  kie_task_id VARCHAR(100) NULL,
  credits DECIMAL(10,2) NULL,
  file_path VARCHAR(255) NULL,
  ig_media_id VARCHAR(64) NULL,
  error VARCHAR(500) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt DATETIME NULL,
  UNIQUE KEY uq_account_slot (account_id, slot),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Not: Var olan tablolara sonradan eklenen sütunları uygulama açılışta kendisi ekler (src/config/migrations.js);
-- aşağıdaki ALTER satırları elle çalıştırmak istersen diye duruyor.

-- Ürün videolarının paylaşılacağı hesap (mevcut tabloya ek kolon; bir kez çalıştır)
ALTER TABLE product_videos ADD COLUMN IF NOT EXISTS ig_account_id INT UNSIGNED NULL;

-- Ürün hesabı işareti (mevcut tabloya ek kolon; bir kez çalıştır)
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS is_product TINYINT(1) NOT NULL DEFAULT 0;

-- Konuşmalı komedi modu (mevcut tabloya ek kolon; bir kez çalıştır)
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS comedy TINYINT(1) NOT NULL DEFAULT 0;

-- Hikaye modu (mevcut tabloya ek kolonlar; bir kez çalıştır)
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS story TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS story_cast TEXT NULL;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS story_since DATETIME NULL;

-- Gate.io hesabında GERÇEK işlemler. Bot alım emrini sadece kullanıcı onaylayınca (Telegram/panel) verir;
-- sadece kendi aldığı miktarı satar, hesaptaki diğer varlıklara dokunmaz.
-- status: proposed (onay bekliyor) → opening (alım emri) → open (stop/hedef borsada) → closing → closed
--         proposed → rejected (Geç) / expired (süresinde onaylanmadı); hata → fail
CREATE TABLE IF NOT EXISTS crypto_trades (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  signal_id INT UNSIGNED NULL,
  pair VARCHAR(40) NOT NULL,
  status ENUM('proposed','rejected','expired','opening','open','closing','closed','fail') NOT NULL DEFAULT 'proposed',
  is_opportunity TINYINT(1) NOT NULL DEFAULT 0,
  quote_amount DECIMAL(30,8) NOT NULL,
  signal_entry DECIMAL(30,12) NOT NULL,
  signal_sl DECIMAL(30,12) NOT NULL,
  signal_tp DECIMAL(30,12) NOT NULL,
  entry_order_id VARCHAR(64) NULL,
  amount DECIMAL(30,12) NULL,
  entry_price DECIMAL(30,12) NULL,
  cost_usdt DECIMAL(30,8) NULL,
  sl_price DECIMAL(30,12) NULL,
  tp_price DECIMAL(30,12) NULL,
  sl_order_id VARCHAR(64) NULL,
  tp_order_id VARCHAR(64) NULL,
  exit_reason ENUM('tp','sl','expired','manual','external','emergency') NULL,
  exit_order_id VARCHAR(64) NULL,
  exit_price DECIMAL(30,12) NULL,
  proceeds_usdt DECIMAL(30,8) NULL,
  pnl_usdt DECIMAL(30,8) NULL,
  pnl_pct DECIMAL(10,3) NULL,
  news_note VARCHAR(500) NULL,
  proposal_message_id BIGINT NULL,
  pending_text VARCHAR(40) NULL,
  pending_at DATETIME NULL,
  pending_cancel VARCHAR(500) NULL,
  expiry_notified TINYINT(1) NOT NULL DEFAULT 0,
  error VARCHAR(500) NULL,
  proposed_at DATETIME NOT NULL,
  opened_at DATETIME NULL,
  closed_at DATETIME NULL,
  INDEX idx_status (status),
  INDEX idx_closed (closed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Gemini'nin haberlere göre bulduğu fırsat coinleri; süreleri dolunca aday listesinden çıkar
CREATE TABLE IF NOT EXISTS crypto_opportunities (
  symbol VARCHAR(30) PRIMARY KEY,
  reason VARCHAR(500) NOT NULL,
  found_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kalıcı sunucu günlüğü (uygulama ilk çalışınca kendisi de oluşturur; 7 gün / 5000 satır tutulur)
CREATE TABLE IF NOT EXISTS app_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  level ENUM('info','warn','error') NOT NULL,
  source VARCHAR(40) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  createdAt DATETIME NOT NULL,
  INDEX idx_created (createdAt),
  INDEX idx_level (level, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
