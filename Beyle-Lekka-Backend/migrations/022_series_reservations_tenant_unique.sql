-- 022_series_reservations_tenant_unique.sql  (SQLite, idempotent)
BEGIN;

PRAGMA foreign_keys = OFF;

-- Clean up any partial previous attempt safely.
DROP TABLE IF EXISTS series_reservations_new;

-- Rebuild series_reservations with per-tenant uniqueness.
CREATE TABLE series_reservations_new (
  reservation_id TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  doc_type       TEXT NOT NULL,
  fy             INTEGER NOT NULL,
  number         TEXT NOT NULL,
  preview_id     TEXT,
  status         TEXT NOT NULL DEFAULT 'HELD',  -- 'HELD' | 'USED' | 'EXPIRED'
  expires_at     TEXT NOT NULL,
  UNIQUE(session_id, doc_type, fy, number)
);

-- Copy existing data using only columns that are guaranteed to exist.
-- If some rows violate the new unique key, INSERT OR IGNORE will skip them.
INSERT OR IGNORE INTO series_reservations_new
  (reservation_id, session_id, doc_type, fy, number, preview_id, status, expires_at)
SELECT reservation_id, session_id, doc_type, fy, number, preview_id, status, expires_at
FROM series_reservations;

-- Swap tables
DROP TABLE IF EXISTS series_reservations;
ALTER TABLE series_reservations_new RENAME TO series_reservations;

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_series_preview ON series_reservations(preview_id);

PRAGMA foreign_keys = ON;

COMMIT;
