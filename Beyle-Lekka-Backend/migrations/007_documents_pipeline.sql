PRAGMA foreign_keys = ON;

-- Files table
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER,
  storage_path TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deterministic extractions (fields only; journals are derived in app)
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  doc_type TEXT,
  fields_json TEXT NOT NULL,
  confidence REAL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- Strengthen uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS uniq_doc_type_number ON documents(doc_type, number);
