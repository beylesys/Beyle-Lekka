PRAGMA foreign_keys = ON;

-- Period locks
CREATE TABLE IF NOT EXISTS closed_periods (
  period_end TEXT NOT NULL,   -- inclusive YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (period_end)
);

DROP TRIGGER IF EXISTS trg_block_closed;
CREATE TRIGGER trg_block_closed
BEFORE INSERT ON ledger_entries
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM closed_periods WHERE NEW.transaction_date <= period_end
)
BEGIN
  SELECT RAISE(ABORT, 'Posting blocked: period closed');
END;

-- Audit log (append-only; app writes to it)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id TEXT,
  action TEXT NOT NULL,         -- e.g., 'post_journal'
  entity TEXT NOT NULL,         -- 'ledger_entries','documents', etc
  entity_id TEXT,
  details_json TEXT,            -- small JSON payload
  session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts ON ledger_entries(debit_account, credit_account);
CREATE INDEX IF NOT EXISTS idx_docs_type_num ON documents(doc_type, number);
