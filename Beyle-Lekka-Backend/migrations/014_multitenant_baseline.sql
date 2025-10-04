PRAGMA foreign_keys=OFF;
BEGIN;

-- Tenant column on tables that participate in the product experience
ALTER TABLE bank_accounts         ADD COLUMN session_id TEXT;
ALTER TABLE bank_statement_lines  ADD COLUMN session_id TEXT;
ALTER TABLE documents             ADD COLUMN session_id TEXT;
ALTER TABLE files                 ADD COLUMN session_id TEXT;
ALTER TABLE extractions           ADD COLUMN session_id TEXT;
ALTER TABLE items                 ADD COLUMN session_id TEXT;
ALTER TABLE stock_ledger          ADD COLUMN session_id TEXT;
ALTER TABLE closed_periods        ADD COLUMN session_id TEXT;
ALTER TABLE warehouses            ADD COLUMN session_id TEXT;
ALTER TABLE coa_synonyms          ADD COLUMN session_id TEXT;
ALTER TABLE series_reservations   ADD COLUMN session_id TEXT;
ALTER TABLE idempotency_keys      ADD COLUMN session_id TEXT;

-- Core indexes for tenant lookups
CREATE INDEX IF NOT EXISTS idx_bank_accounts_sid            ON bank_accounts(session_id);
CREATE INDEX IF NOT EXISTS idx_bank_lines_sid               ON bank_statement_lines(session_id);
CREATE INDEX IF NOT EXISTS idx_bank_lines_sid_status        ON bank_statement_lines(session_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_lines_sid_acct_date     ON bank_statement_lines(session_id, bank_account_id, value_date);
CREATE INDEX IF NOT EXISTS idx_documents_sid_created        ON documents(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_items_sid                    ON items(session_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_sid             ON stock_ledger(session_id);
CREATE INDEX IF NOT EXISTS idx_closed_periods_sid           ON closed_periods(session_id);
CREATE INDEX IF NOT EXISTS idx_files_sid                    ON files(session_id);
CREATE INDEX IF NOT EXISTS idx_extractions_sid              ON extractions(session_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_sid               ON warehouses(session_id);
CREATE INDEX IF NOT EXISTS idx_coa_synonyms_sid             ON coa_synonyms(session_id);
CREATE INDEX IF NOT EXISTS idx_series_res_sid               ON series_reservations(session_id);
CREATE INDEX IF NOT EXISTS idx_idem_keys_sid                ON idempotency_keys(session_id);

COMMIT;
PRAGMA foreign_keys=ON;
