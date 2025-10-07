BEGIN;

PRAGMA foreign_keys = ON;

/* ---------- Import batches (one row per uploaded file) ---------- */
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,                -- tenant/workspace
  file_id TEXT NOT NULL,                   -- references files.id
  profile_id TEXT,                         -- chosen generic profile (e.g., 'csv-universal-journal-v1')
  status TEXT NOT NULL CHECK (status IN ('UPLOADED','PARSED','PREVIEW','COMMITTED','FAILED')) DEFAULT 'UPLOADED',
  counts_json TEXT,                        -- summary counts for preview
  errors_json TEXT,                        -- top errors for UI
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_batches_sid ON import_batches(session_id);

/* ---------- Row-level staging for preview (normalized but not posted) ---------- */
CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('journal_line','pair','bank_txn')),
  raw_json TEXT,                           -- original (optional)
  normalized_json TEXT NOT NULL,           -- canonical record used for posting
  status TEXT NOT NULL CHECK (status IN ('NEW','NORMALIZED','INVALID')) DEFAULT 'NORMALIZED',
  error TEXT,
  FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);

/* ---------- External mappings (per-tenant) ----------
   Stores both entity mapping (account/party/item) and field mapping (header→field).
   'source' is a free string (profile id, or 'manual').
*/
CREATE TABLE IF NOT EXISTS external_mappings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('account','party','item','field')),
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  target_code TEXT,
  confidence REAL,
  rationale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, scope, source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_extmap_sid_scope ON external_mappings(session_id, scope);

COMMIT;
