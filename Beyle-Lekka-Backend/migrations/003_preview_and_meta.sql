PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS preview_snapshots (
  preview_id       TEXT PRIMARY KEY,
  doc_type         TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  hash             TEXT NOT NULL,
  reservation_id   TEXT NOT NULL,
  reserved_number  TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_by       TEXT,
  session_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','USED','EXPIRED')) DEFAULT 'ACTIVE'
);
CREATE INDEX IF NOT EXISTS idx_preview_status ON preview_snapshots(status);
CREATE INDEX IF NOT EXISTS idx_preview_expires ON preview_snapshots(expires_at);

CREATE TABLE IF NOT EXISTS series_reservations (
  reservation_id   TEXT PRIMARY KEY,
  doc_type         TEXT NOT NULL,
  fy               INTEGER NOT NULL,
  number           TEXT NOT NULL,
  preview_id       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('HELD','USED','EXPIRED')) DEFAULT 'HELD',
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_series_res ON series_reservations(doc_type, fy, number);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  doc_type     TEXT NOT NULL,
  number       TEXT NOT NULL,
  date         TEXT NOT NULL,
  party_name   TEXT,
  gross_amount REAL,
  status       TEXT NOT NULL DEFAULT 'FINALIZED',
  file_url     TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_num ON documents(number);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key       TEXT PRIMARY KEY,
  doc_id    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
