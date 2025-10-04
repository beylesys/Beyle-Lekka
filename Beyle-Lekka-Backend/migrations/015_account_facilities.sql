PRAGMA foreign_keys = ON;

-- Account facilities: OD/OCC/LOAN/LIMIT_ONLY linked to the ledger the user transacts on.
CREATE TABLE IF NOT EXISTS account_facilities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  primary_account TEXT NOT NULL,            -- COA name/code of the spending instrument (Bank/OD/OCC/Loan)
  facility_type TEXT NOT NULL CHECK (facility_type IN ('OD','OCC','LOAN','LIMIT_ONLY')),
  limit_cents INTEGER NOT NULL DEFAULT 0,   -- approved limit in paise
  valid_from TEXT,                          -- 'YYYY-MM-DD'
  valid_to   TEXT,                          -- 'YYYY-MM-DD'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facilities_sid_acct ON account_facilities(session_id, primary_account);
