PRAGMA foreign_keys=OFF;
BEGIN;

-- 0) Drop dependent triggers first (ledger_entries)
DROP TRIGGER IF EXISTS trg_block_closed;
DROP TRIGGER IF EXISTS trg_block_overflow_insert;
DROP TRIGGER IF EXISTS trg_block_overflow_update;

-- 1) Rebuild CLOSED_PERIODS with tenant scope (composite PK)
CREATE TABLE IF NOT EXISTS closed_periods (
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS closed_periods_v2 (
  session_id TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, period_end)
);

INSERT OR IGNORE INTO closed_periods_v2 (session_id, period_end, created_at)
SELECT COALESCE(session_id, 'GLOBAL'), period_end, created_at
FROM closed_periods;

DROP TABLE IF EXISTS closed_periods;
ALTER TABLE closed_periods_v2 RENAME TO closed_periods;
CREATE INDEX IF NOT EXISTS idx_closed_periods_sid ON closed_periods(session_id);

-- 2) Recreate the closed-period guard trigger (tenant-scoped)
CREATE TRIGGER trg_block_closed
BEFORE INSERT ON ledger_entries
FOR EACH ROW WHEN EXISTS (
  SELECT 1
    FROM closed_periods cp
   WHERE cp.session_id = NEW.session_id
     AND NEW.transaction_date <= cp.period_end
)
BEGIN
  SELECT RAISE(ABORT, 'period_closed');
END;

-- 3) Rebuild DOCUMENT_SERIES (tenant/year scoped)
CREATE TABLE IF NOT EXISTS document_series (
  doc_type TEXT PRIMARY KEY,
  prefix   TEXT NOT NULL,
  year     INTEGER NOT NULL,
  curr     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document_series_v2 (
  session_id TEXT NOT NULL,
  doc_type   TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  year       INTEGER NOT NULL,
  curr       INTEGER NOT NULL,
  PRIMARY KEY (session_id, doc_type, year)
);

INSERT OR IGNORE INTO document_series_v2 (session_id, doc_type, prefix, year, curr)
SELECT 'GLOBAL', doc_type, prefix, year, curr
FROM document_series;

DROP TABLE IF EXISTS document_series;
ALTER TABLE document_series_v2 RENAME TO document_series;

-- 4) Per-tenant uniqueness & helpful indexes
CREATE UNIQUE INDEX IF NOT EXISTS uniq_series_res_sid
  ON series_reservations(session_id, doc_type, fy, number);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_idempotency_sid_key
  ON idempotency_keys(session_id, key);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_sid_type_number
  ON documents(session_id, doc_type, number);

-- 5) Recreate bank outflow guard triggers with amount_cents only
CREATE TRIGGER trg_block_overflow_insert
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN (
  LOWER(NEW.credit_account) LIKE '%bank%' OR
  LOWER(NEW.credit_account) LIKE '%cash%' OR
  LOWER(NEW.credit_account) LIKE '%loan%'
)
BEGIN
  SELECT
    CASE
      WHEN (
        COALESCE((
          SELECT
            COALESCE(SUM(CASE WHEN debit_account  = NEW.credit_account THEN amount_cents ELSE 0 END),0)
            - COALESCE(SUM(CASE WHEN credit_account = NEW.credit_account THEN amount_cents ELSE 0 END),0)
          FROM ledger_entries
          WHERE transaction_date <= NEW.transaction_date
            AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
        ), 0)
        +
        COALESCE((
          SELECT limit_cents
            FROM account_facilities
           WHERE primary_account = NEW.credit_account
             AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
             AND (valid_from IS NULL OR valid_from <= NEW.transaction_date)
             AND (valid_to   IS NULL OR valid_to   >= NEW.transaction_date)
           LIMIT 1
        ), 0)
        -
        COALESCE((
          SELECT COALESCE(SUM(amount_cents),0)
            FROM funds_holds
           WHERE account = NEW.credit_account
             AND hold_date = NEW.transaction_date
             AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
             AND expires_at > datetime('now')
        ),0)
      ) < NEW.amount_cents
      THEN RAISE(ABORT, 'Insufficient funds/facility headroom for outflow')
    END;
END;

CREATE TRIGGER trg_block_overflow_update
BEFORE UPDATE OF amount_cents, credit_account, transaction_date, session_id ON ledger_entries
FOR EACH ROW
WHEN (
  LOWER(NEW.credit_account) LIKE '%bank%' OR
  LOWER(NEW.credit_account) LIKE '%cash%' OR
  LOWER(NEW.credit_account) LIKE '%loan%'
)
BEGIN
  SELECT
    CASE
      WHEN (
        COALESCE((
          SELECT
            COALESCE(SUM(CASE WHEN debit_account  = NEW.credit_account THEN amount_cents ELSE 0 END),0)
            - COALESCE(SUM(CASE WHEN credit_account = NEW.credit_account THEN amount_cents ELSE 0 END),0)
          FROM ledger_entries
          WHERE transaction_date <= NEW.transaction_date
            AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
        ), 0)
        +
        COALESCE((
          SELECT limit_cents
            FROM account_facilities
           WHERE primary_account = NEW.credit_account
             AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
             AND (valid_from IS NULL OR valid_from <= NEW.transaction_date)
             AND (valid_to   IS NULL OR valid_to   >= NEW.transaction_date)
           LIMIT 1
        ), 0)
        -
        COALESCE((
          SELECT COALESCE(SUM(amount_cents),0)
            FROM funds_holds
           WHERE account = NEW.credit_account
             AND hold_date = NEW.transaction_date
             AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
             AND expires_at > datetime('now')
        ),0)
      ) < NEW.amount_cents
      THEN RAISE(ABORT, 'Insufficient funds/facility headroom for outflow')
    END;
END;

COMMIT;
PRAGMA foreign_keys=ON;
