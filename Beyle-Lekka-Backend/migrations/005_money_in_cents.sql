PRAGMA foreign_keys = ON;

-- 005_money_in_cents.sql
-- Convert monetary values to integer minor units (cents/paise) and add a compatibility view.

-- 1) New ledger_entries table with amount_cents INTEGER
CREATE TABLE IF NOT EXISTS ledger_entries_v2 (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  narration TEXT,
  transaction_date TEXT NOT NULL,
  document_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2) Backfill from old REAL column if present
INSERT INTO ledger_entries_v2
  (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, document_id, created_at)
SELECT
  id,
  session_id,
  debit_account,
  credit_account,
  CAST(ROUND(amount * 100.0) AS INTEGER),
  narration,
  transaction_date,
  document_id,
  created_at
FROM ledger_entries;

-- 3) Swap tables
ALTER TABLE ledger_entries RENAME TO ledger_entries_old;
ALTER TABLE ledger_entries_v2 RENAME TO ledger_entries;

-- 4) Recreate essential indexes & triggers (copied from 001/002)
CREATE INDEX IF NOT EXISTS idx_ledger_txn_date ON ledger_entries(transaction_date);

-- Prevent same account both sides
CREATE TRIGGER IF NOT EXISTS trg_no_self_account
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.debit_account = NEW.credit_account
BEGIN
  SELECT RAISE(ABORT, 'debit_account and credit_account cannot be the same');
END;

-- Guard: YYYY-MM-DD format
CREATE TRIGGER IF NOT EXISTS trg_date_format
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'Invalid transaction_date format');
END;

-- 5) Backward-compatibility view exposing amount as REAL (units)
DROP VIEW IF EXISTS ledger_entries_view;
CREATE VIEW ledger_entries_view AS
SELECT
  id, session_id, debit_account, credit_account,
  (amount_cents / 100.0) AS amount,
  narration, transaction_date, document_id, created_at
FROM ledger_entries;

-- 6) Documents.gross_amount_cents
ALTER TABLE documents ADD COLUMN gross_amount_cents INTEGER;
UPDATE documents
SET gross_amount_cents = CASE
  WHEN gross_amount IS NOT NULL THEN CAST(ROUND(gross_amount * 100.0) AS INTEGER)
  ELSE NULL
END;

-- Keep old columns for now; code should move to *_cents.
