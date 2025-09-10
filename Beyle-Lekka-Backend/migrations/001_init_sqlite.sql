PRAGMA foreign_keys = ON;

-- Ledger entries
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,                 -- app generates UUID
  session_id TEXT,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  narration TEXT,
  transaction_date TEXT NOT NULL,      -- 'YYYY-MM-DD'
  document_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_date ON ledger_entries(transaction_date);

-- Memory log
CREATE TABLE IF NOT EXISTS memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT,
  prompt TEXT,
  result TEXT,                         -- JSON stored as TEXT; parse in app
  type TEXT,
  status TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
