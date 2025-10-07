BEGIN;

/* Add content-hash column; nullable for existing rows. */
ALTER TABLE ledger_entries ADD COLUMN uniq_hash TEXT;

/* Fast lookup by (session_id, uniq_hash). */
CREATE INDEX IF NOT EXISTS idx_ledger_entries_sid_uniq
  ON ledger_entries(session_id, uniq_hash);

/* Enforce uniqueness of content within a tenant/session when uniq_hash is set. 
   Partial index WHERE uniq_hash IS NOT NULL is supported in SQLite 3.8+ and Postgres. */
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_entries_sid_uniq
  ON ledger_entries(session_id, uniq_hash)
  WHERE uniq_hash IS NOT NULL;

COMMIT;
