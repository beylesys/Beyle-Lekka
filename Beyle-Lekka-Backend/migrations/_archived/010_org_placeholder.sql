PRAGMA foreign_keys = ON;

-- Transparent 'org_id' so multi-tenant cutover is painless later.
ALTER TABLE ledger_entries ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE documents     ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preview_snapshots ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE series_reservations ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE files         ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE extractions   ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE bank_accounts ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE bank_statement_lines ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
-- Later you can add UNIQUE(org_id, doc_type, number) etc.
