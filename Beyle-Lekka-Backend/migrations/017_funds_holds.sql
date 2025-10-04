PRAGMA foreign_keys = ON;

-- Temporary reservations created at preview time to avoid concurrent over-spend.
CREATE TABLE IF NOT EXISTS funds_holds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  account TEXT NOT NULL,
  hold_date TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  amount_cents INTEGER NOT NULL,           -- paise; positive = outflow reservation
  preview_id TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holds_sid_acct_date ON funds_holds(session_id, account, hold_date);
CREATE INDEX IF NOT EXISTS idx_holds_expiry ON funds_holds(expires_at);
