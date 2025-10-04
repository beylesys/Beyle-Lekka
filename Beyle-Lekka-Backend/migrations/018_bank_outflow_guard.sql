PRAGMA foreign_keys = ON;

-- Guard: block inserts/updates that would overshoot available headroom on cash/bank/loan instruments.
DROP TRIGGER IF EXISTS trg_block_overflow_insert;
CREATE TRIGGER trg_block_overflow_insert
BEFORE INSERT ON ledger_entries
FOR EACH ROW
WHEN (LOWER(NEW.credit_account) LIKE '%bank%' OR LOWER(NEW.credit_account) LIKE '%cash%' OR LOWER(NEW.credit_account) LIKE '%loan%')
BEGIN
  SELECT
    CASE
      WHEN (
        -- Balance as-of date (Dr - Cr)
        COALESCE((
          SELECT
            COALESCE(SUM(CASE WHEN debit_account  = NEW.credit_account THEN COALESCE(amount_cents, CAST(ROUND(amount*100.0) AS INTEGER)) ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN credit_account = NEW.credit_account THEN COALESCE(amount_cents, CAST(ROUND(amount*100.0) AS INTEGER)) ELSE 0 END),0)
          FROM ledger_entries
          WHERE transaction_date <= NEW.transaction_date
            AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
        ),0)
        +
        -- Facility limit (if present and valid on date); applies equally for OD/OCC/LOAN
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
        -- Active holds by other previews on the same date
        COALESCE((
          SELECT COALESCE(SUM(amount_cents),0)
            FROM funds_holds
           WHERE account = NEW.credit_account
             AND hold_date = NEW.transaction_date
             AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
             AND expires_at > datetime('now')
        ),0)
      ) < COALESCE(NEW.amount_cents, CAST(ROUND(NEW.amount*100.0) AS INTEGER))
      THEN RAISE(ABORT, 'Insufficient funds/facility headroom for outflow')
    END;
END;

DROP TRIGGER IF EXISTS trg_block_overflow_update;
CREATE TRIGGER trg_block_overflow_update
BEFORE UPDATE OF amount, amount_cents, credit_account, transaction_date, session_id ON ledger_entries
FOR EACH ROW
WHEN (LOWER(NEW.credit_account) LIKE '%bank%' OR LOWER(NEW.credit_account) LIKE '%cash%' OR LOWER(NEW.credit_account) LIKE '%loan%')
BEGIN
  SELECT
    CASE
      WHEN (
        COALESCE((
          SELECT
            COALESCE(SUM(CASE WHEN debit_account  = NEW.credit_account THEN COALESCE(amount_cents, CAST(ROUND(amount*100.0) AS INTEGER)) ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN credit_account = NEW.credit_account THEN COALESCE(amount_cents, CAST(ROUND(amount*100.0) AS INTEGER)) ELSE 0 END),0)
          FROM ledger_entries
          WHERE transaction_date <= NEW.transaction_date
            AND (NEW.session_id IS NULL OR session_id = NEW.session_id)
            AND id <> OLD.id
        ),0)
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
      ) < COALESCE(NEW.amount_cents, CAST(ROUND(NEW.amount*100.0) AS INTEGER))
      THEN RAISE(ABORT, 'Insufficient funds/facility headroom for outflow')
    END;
END;
