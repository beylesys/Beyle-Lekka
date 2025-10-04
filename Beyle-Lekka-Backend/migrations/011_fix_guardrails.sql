BEGIN;
PRAGMA foreign_keys = ON;

/* Enforce debit != credit on INSERT & UPDATE */
DROP TRIGGER IF EXISTS trg_no_self_account_ins;
DROP TRIGGER IF EXISTS trg_no_self_account_upd;

CREATE TRIGGER trg_no_self_account_ins
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.debit_account = NEW.credit_account
BEGIN
  SELECT RAISE(ABORT, 'debit_account and credit_account cannot be the same');
END;

CREATE TRIGGER trg_no_self_account_upd
BEFORE UPDATE ON ledger_entries
FOR EACH ROW
WHEN NEW.debit_account = NEW.credit_account
BEGIN
  SELECT RAISE(ABORT, 'debit_account and credit_account cannot be the same');
END;

/* Date format YYYY-MM-DD */
DROP TRIGGER IF EXISTS trg_date_format_ins;
DROP TRIGGER IF EXISTS trg_date_format_upd;

CREATE TRIGGER trg_date_format_ins
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'Invalid transaction_date format');
END;

CREATE TRIGGER trg_date_format_upd
BEFORE UPDATE ON ledger_entries
FOR EACH ROW
WHEN NEW.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'Invalid transaction_date format');
END;

/* CoA existence & active (both legs) */
DROP TRIGGER IF EXISTS trg_debit_exists;
DROP TRIGGER IF EXISTS trg_credit_exists;
DROP TRIGGER IF EXISTS trg_debit_exists_upd;
DROP TRIGGER IF EXISTS trg_credit_exists_upd;

CREATE TRIGGER trg_debit_exists
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE is_active = 1 AND (name = NEW.debit_account OR account_code = NEW.debit_account)
)
BEGIN
  SELECT RAISE(ABORT, 'Debit ledger missing or inactive in chart_of_accounts');
END;

CREATE TRIGGER trg_credit_exists
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE is_active = 1 AND (name = NEW.credit_account OR account_code = NEW.credit_account)
)
BEGIN
  SELECT RAISE(ABORT, 'Credit ledger missing or inactive in chart_of_accounts');
END;

CREATE TRIGGER trg_debit_exists_upd
BEFORE UPDATE ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE is_active = 1 AND (name = NEW.debit_account OR account_code = NEW.debit_account)
)
BEGIN
  SELECT RAISE(ABORT, 'Debit ledger missing or inactive in chart_of_accounts');
END;

CREATE TRIGGER trg_credit_exists_upd
BEFORE UPDATE ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE is_active = 1 AND (name = NEW.credit_account OR account_code = NEW.credit_account)
)
BEGIN
  SELECT RAISE(ABORT, 'Credit ledger missing or inactive in chart_of_accounts');
END;

/* Helpful indexes */
CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn_date  ON ledger_entries (transaction_date);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_debit     ON ledger_entries (debit_account);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_credit    ON ledger_entries (credit_account);

CREATE UNIQUE INDEX IF NOT EXISTS ux_coa_name_nocase ON chart_of_accounts (name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS ux_coa_code        ON chart_of_accounts (account_code)
  WHERE account_code IS NOT NULL;

COMMIT;
