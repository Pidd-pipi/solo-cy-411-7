-- 002_accounting_periods.sql
-- Monthly carbon accounting close feature.
-- Idempotent: safe to run on an existing carbontrack database.
-- Fresh databases already get these tables from init.sql; this script is for
-- Docker named volumes that were initialized before the feature was added.
--
-- Apply (from repository root):
--   docker compose exec -T db mysql -ucarbontrack_user -pcarbontrack_pwd carbontrack_db < database/migrations/002_accounting_periods.sql

-- Monthly carbon accounting period (close / reopen lock ledger)
CREATE TABLE IF NOT EXISTS accounting_periods (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  period CHAR(7) NOT NULL,                          -- 'YYYY-MM' calendar month
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  current_version INT NOT NULL DEFAULT 0,
  closed_by BIGINT NULL,
  closed_at TIMESTAMP NULL,
  reopen_reason VARCHAR(255) NULL,
  reopened_by BIGINT NULL,
  reopened_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_accounting_period_period (period),
  CONSTRAINT fk_accounting_period_closed_by FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_accounting_period_reopened_by FOREIGN KEY (reopened_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Member summary + personal detail snapshot per period version (frozen close data)
CREATE TABLE IF NOT EXISTS accounting_snapshots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  period_id BIGINT NOT NULL,
  version INT NOT NULL,
  user_id BIGINT NOT NULL,
  region VARCHAR(64) NOT NULL,
  activity_count INT NOT NULL DEFAULT 0,
  total_carbon DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  by_category JSON NOT NULL,                        -- {transport,energy,food,shopping}
  detail JSON NOT NULL,                             -- frozen Activity-shaped rows
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_snapshot_period_version_user (period_id, version, user_id),
  KEY idx_snapshot_user_period (user_id, period_id),
  CONSTRAINT fk_snapshot_period FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE CASCADE,
  CONSTRAINT fk_snapshot_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
