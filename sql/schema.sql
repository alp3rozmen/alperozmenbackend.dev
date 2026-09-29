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

-- Dolap ilan görseli şablonları (Gemini'ye stil referansı olarak verilir)
CREATE TABLE IF NOT EXISTS dolap_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  mime VARCHAR(50) NOT NULL,
  image MEDIUMBLOB NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
