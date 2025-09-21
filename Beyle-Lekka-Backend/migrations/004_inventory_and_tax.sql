PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  uom           TEXT,
  stock_tracked INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_ledger (
  id        TEXT PRIMARY KEY,
  date      TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  qty_in    REAL NOT NULL DEFAULT 0,
  qty_out   REAL NOT NULL DEFAULT 0,
  ref_doc   TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_ledger(item_id);
