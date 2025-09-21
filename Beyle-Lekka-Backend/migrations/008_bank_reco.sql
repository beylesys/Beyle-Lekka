PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_no TEXT,
  ifsc TEXT,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL,
  value_date TEXT NOT NULL,
  narration TEXT,
  amount_cents INTEGER NOT NULL,
  ext_ref TEXT,
  imported_file_id TEXT,
  matched_ledger_id TEXT,
  status TEXT CHECK (status IN ('unmatched','matched','excluded')) NOT NULL DEFAULT 'unmatched',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id),
  FOREIGN KEY(matched_ledger_id) REFERENCES ledger_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_bank_lines_acct_date ON bank_statement_lines(bank_account_id, value_date);
CREATE INDEX IF NOT EXISTS idx_bank_lines_status ON bank_statement_lines(status);
