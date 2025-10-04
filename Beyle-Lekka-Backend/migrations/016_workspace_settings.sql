PRAGMA foreign_keys = ON;

-- Per-workspace settings (keep it minimal for now)
CREATE TABLE IF NOT EXISTS workspace_settings (
  session_id TEXT PRIMARY KEY,
  default_spending_account TEXT NOT NULL,   -- default ledger to credit for payments (e.g., 'HDFC OD')
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
