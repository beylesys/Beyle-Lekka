BEGIN;

-- Add columns only if missing (works on modern SQLite and Postgres)
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS family_code TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS rationale TEXT;

-- Fast search by family within a tenant
CREATE INDEX IF NOT EXISTS idx_coa_sid_family
  ON chart_of_accounts(session_id, family_code);

-- Prevent duplicate ledger names per tenant (case-insensitive)
-- (SQLite supports expression indexes; Postgres does too.)
CREATE UNIQUE INDEX IF NOT EXISTS ux_coa_sid_name_lower
  ON chart_of_accounts(session_id, lower(name));

COMMIT;
