-- 024_drop_global_doc_unique.sql
BEGIN;
-- Remove the legacy global uniqueness that blocks per-tenant numbering.
DROP INDEX IF EXISTS uniq_doc_type_number;

-- Make sure the correct per-tenant uniqueness exists.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_sid_type_number
  ON documents(session_id, doc_type, number);

-- Guardrail: refuse inserts that forget session_id when number is present.
CREATE TRIGGER IF NOT EXISTS trg_documents_require_session
BEFORE INSERT ON documents
FOR EACH ROW
WHEN NEW.number IS NOT NULL AND NEW.session_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'session_id required for document rows');
END;
COMMIT;
