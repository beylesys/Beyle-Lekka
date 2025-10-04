-- migrations/018_coa_multitenant.sql
PRAGMA foreign_keys=OFF;
BEGIN;

-- 1) Add tenant column (idempotent-ish: run once per DB)
ALTER TABLE chart_of_accounts ADD COLUMN session_id TEXT;

-- 2) Backfill existing rows to a neutral scope so nothing breaks mid-way
UPDATE chart_of_accounts SET session_id = COALESCE(session_id, 'GLOBAL');

-- 3) Add indexes for fast tenant lookups
CREATE INDEX IF NOT EXISTS idx_coa_sid_name ON chart_of_accounts(session_id, name);
CREATE INDEX IF NOT EXISTS idx_coa_sid_code ON chart_of_accounts(session_id, account_code);

COMMIT;
PRAGMA foreign_keys=ON;
