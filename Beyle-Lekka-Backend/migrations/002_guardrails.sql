-- 002_guardrails.sql

-- Optional Chart of Accounts
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  account_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  normal_balance TEXT CHECK (normal_balance IN ('debit','credit')),
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance) VALUES
  ('Cash', 'Cash', 'Asset', 'debit'),
  ('Bank', 'Bank', 'Asset', 'debit'),
  ('Accounts Receivable', 'Accounts Receivable', 'Asset', 'debit'),
  ('Accounts Payable', 'Accounts Payable', 'Liability', 'credit');

-- Idempotency: prevent duplicate rows per document
CREATE UNIQUE INDEX IF NOT EXISTS u_ledger_dedup
ON ledger_entries(document_id, debit_account, credit_account, transaction_date, narration, amount);

-- Guard: block same debit/credit
CREATE TRIGGER IF NOT EXISTS trg_no_same_account
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.debit_account = NEW.credit_account
BEGIN
  SELECT RAISE(ABORT, 'debit_account and credit_account cannot be the same');
END;

-- Guard: date format YYYY-MM-DD
CREATE TRIGGER IF NOT EXISTS trg_date_format
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NEW.transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'Invalid transaction_date format');
END;
