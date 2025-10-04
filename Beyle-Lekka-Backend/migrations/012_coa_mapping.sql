BEGIN;
PRAGMA foreign_keys = ON;

/* 1) Synonym catalog for CoA typing and grouping */
CREATE TABLE IF NOT EXISTS coa_synonyms (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,  -- store lowercase patterns, use LIKE with lower(account)
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  group_code TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS idx_coa_synonyms_pattern ON coa_synonyms(pattern);
CREATE INDEX IF NOT EXISTS idx_coa_synonyms_priority ON coa_synonyms(priority);

/* 2) Seed common mappings (edit/extend later) */
/* Assets */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%cash%','asset','debit','assets.current.cash',10),
('%bank%','asset','debit','assets.current.bank',10),
('%hdfc%','asset','debit','assets.current.bank',20),
('%icici%','asset','debit','assets.current.bank',20),
('%sbi%','asset','debit','assets.current.bank',20),
('%axis bank%','asset','debit','assets.current.bank',20),
('%kotak%','asset','debit','assets.current.bank',20),
('%yes bank%','asset','debit','assets.current.bank',20),
('%debtor%','asset','debit','assets.current.receivables',15),
('%accounts receivable%','asset','debit','assets.current.receivables',15),
('%receivable%','asset','debit','assets.current.receivables',30),
('%customer%','asset','debit','assets.current.receivables',30),
('%inventory%','asset','debit','assets.current.inventory',20),
('%stock%','asset','debit','assets.current.inventory',20),
('%tds receivable%','asset','debit','assets.current.tax.tds.input',20),
('%gst input (cgst)%','asset','debit','assets.current.tax.gst.itc.cgst',5),
('%gst input (sgst)%','asset','debit','assets.current.tax.gst.itc.sgst',5),
('%gst input (igst)%','asset','debit','assets.current.tax.gst.itc.igst',5),
('%itc%','asset','debit','assets.current.tax.gst.itc',30),
('%gst input%','asset','debit','assets.current.tax.gst.itc',30);

/* Fixed assets */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%office equipment%','asset','debit','assets.noncurrent.fixed',10),
('%fixed asset%','asset','debit','assets.noncurrent.fixed',20),
('%equipment%','asset','debit','assets.noncurrent.fixed',30),
('%furniture%','asset','debit','assets.noncurrent.fixed',30),
('%computer%','asset','debit','assets.noncurrent.fixed',30),
('%laptop%','asset','debit','assets.noncurrent.fixed',30),
('%plant%','asset','debit','assets.noncurrent.fixed',30),
('%machinery%','asset','debit','assets.noncurrent.fixed',30),
('%vehicle%','asset','debit','assets.noncurrent.fixed',30);

/* Liabilities */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%creditor%','liability','credit','liabilities.current.payables',10),
('%accounts payable%','liability','credit','liabilities.current.payables',10),
('%payable%','liability','credit','liabilities.current.payables',30),
('%vendor%','liability','credit','liabilities.current.payables',30),
('%loan%','liability','credit','liabilities.loans',20),
('%overdraft%','liability','credit','liabilities.loans',20),
('%tds payable%','liability','credit','liabilities.current.tax.tds.payable',10),
('%gst output (cgst)%','liability','credit','liabilities.current.tax.gst.output.cgst',5),
('%gst output (sgst)%','liability','credit','liabilities.current.tax.gst.output.sgst',5),
('%gst output (igst)%','liability','credit','liabilities.current.tax.gst.output.igst',5),
('%gst payable%','liability','credit','liabilities.current.tax.gst.output',20),
('%gst output%','liability','credit','liabilities.current.tax.gst.output',20);

/* Equity */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%share capital%','equity','credit','equity.share_capital',10),
('%capital%','equity','credit','equity.capital',20),
('%retained earnings%','equity','credit','equity.retained',20),
('%reserves%','equity','credit','equity.reserves',20),
('%drawings%','equity','debit','equity.drawings',10);

/* Income */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%sales%','income','credit','income.sales',10),
('%revenue%','income','credit','income.sales',20),
('%service income%','income','credit','income.services',10),
('%interest income%','income','credit','income.other.interest',20),
('%other income%','income','credit','income.other',30),
('%discount received%','income','credit','income.other',30);

/* Expenses */
INSERT OR IGNORE INTO coa_synonyms (pattern,type,normal_balance,group_code,priority) VALUES
('%purchase%','expense','debit','expense.cogs',10),
('%cogs%','expense','debit','expense.cogs',10),
('%rent%','expense','debit','expense.rent',10),
('%salary%','expense','debit','expense.employee',10),
('%wages%','expense','debit','expense.employee',10),
('%electricity%','expense','debit','expense.utilities',10),
('%utilities%','expense','debit','expense.utilities',20),
('%internet%','expense','debit','expense.utilities',20),
('%telephone%','expense','debit','expense.utilities',20),
('%bank charges%','expense','debit','expense.bank_charges',10),
('%commission%','expense','debit','expense.commission',10),
('%freight%','expense','debit','expense.freight',10),
('%carriage%','expense','debit','expense.freight',10),
('%fuel%','expense','debit','expense.travel',20),
('%travel%','expense','debit','expense.travel',20),
('%conveyance%','expense','debit','expense.travel',20),
('%repairs%','expense','debit','expense.repairs',20),
('%maintenance%','expense','debit','expense.repairs',20),
('%printing%','expense','debit','expense.admin',20),
('%postage%','expense','debit','expense.admin',20),
('%advertising%','expense','debit','expense.marketing',20),
('%marketing%','expense','debit','expense.marketing',20),
('%insurance%','expense','debit','expense.insurance',20);

/* 3) Auto‑fill CoA for unknown/untyped ledgers BEFORE posting entries */
DROP TRIGGER IF EXISTS trg_05_coa_autofill_debit;
DROP TRIGGER IF EXISTS trg_05_coa_autofill_credit;

CREATE TRIGGER trg_05_coa_autofill_debit
BEFORE INSERT ON ledger_entries
FOR EACH ROW
BEGIN
  INSERT OR IGNORE INTO chart_of_accounts(name, type, normal_balance, is_active)
  SELECT NEW.debit_account,
         (SELECT s.type FROM coa_synonyms s WHERE lower(NEW.debit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1),
         (SELECT s.normal_balance FROM coa_synonyms s WHERE lower(NEW.debit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1),
         1;

  UPDATE chart_of_accounts
     SET type = COALESCE(type, (SELECT s.type FROM coa_synonyms s WHERE lower(NEW.debit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1)),
         normal_balance = COALESCE(normal_balance, (SELECT s.normal_balance FROM coa_synonyms s WHERE lower(NEW.debit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1))
   WHERE name = NEW.debit_account;
END;

CREATE TRIGGER trg_05_coa_autofill_credit
BEFORE INSERT ON ledger_entries
FOR EACH ROW
BEGIN
  INSERT OR IGNORE INTO chart_of_accounts(name, type, normal_balance, is_active)
  SELECT NEW.credit_account,
         (SELECT s.type FROM coa_synonyms s WHERE lower(NEW.credit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1),
         (SELECT s.normal_balance FROM coa_synonyms s WHERE lower(NEW.credit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1),
         1;

  UPDATE chart_of_accounts
     SET type = COALESCE(type, (SELECT s.type FROM coa_synonyms s WHERE lower(NEW.credit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1)),
         normal_balance = COALESCE(normal_balance, (SELECT s.normal_balance FROM coa_synonyms s WHERE lower(NEW.credit_account) LIKE s.pattern ORDER BY s.priority LIMIT 1))
   WHERE name = NEW.credit_account;
END;

/* 4) Guardrails: block untyped ledgers (runs AFTER autofill) */
DROP TRIGGER IF EXISTS trg_10_require_typed_debit;
DROP TRIGGER IF EXISTS trg_10_require_typed_credit;

CREATE TRIGGER trg_10_require_typed_debit
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE name = NEW.debit_account
     AND LOWER(type) IN ('asset','liability','equity','income','expense')
)
BEGIN
  SELECT RAISE(ABORT, 'Debit ledger missing type in chart_of_accounts');
END;

CREATE TRIGGER trg_10_require_typed_credit
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM chart_of_accounts
   WHERE name = NEW.credit_account
     AND LOWER(type) IN ('asset','liability','equity','income','expense')
)
BEGIN
  SELECT RAISE(ABORT, 'Credit ledger missing type in chart_of_accounts');
END;

/* 5) Backfill existing CoA rows that are empty */
UPDATE chart_of_accounts AS c
   SET type = COALESCE(
         c.type,
         (SELECT s.type FROM coa_synonyms s WHERE lower(c.name) LIKE s.pattern ORDER BY s.priority LIMIT 1)
       ),
       normal_balance = COALESCE(
         c.normal_balance,
         (SELECT s.normal_balance FROM coa_synonyms s WHERE lower(c.name) LIKE s.pattern ORDER BY s.priority LIMIT 1)
       )
 WHERE (c.type IS NULL OR c.type = '' OR c.normal_balance IS NULL OR c.normal_balance = '');

COMMIT;
