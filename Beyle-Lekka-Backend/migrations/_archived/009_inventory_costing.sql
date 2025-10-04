PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE stock_ledger ADD COLUMN warehouse_id TEXT;
ALTER TABLE stock_ledger ADD COLUMN rate_cents INTEGER;   -- acquisition rate per unit in cents
ALTER TABLE stock_ledger ADD COLUMN value_cents INTEGER;  -- qty * rate at posting time

CREATE INDEX IF NOT EXISTS idx_stock_wh ON stock_ledger(warehouse_id);
