// controllers/bankReconciliation.js
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import { query } from "../services/db.js";
import { rankCandidates } from "../utils/reco/matcher.js";

const UPLOAD_DIR = path.resolve("./uploads/bank");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")),
});

export const uploadCSV = multer({ storage });

// --- helpers ---------------------------------------------------------------

function normalizeDateLike(v) {
  if (!v) return null;
  const s = String(v).trim();
  // If DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY → YYYY-MM-DD
  const m = s.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // If already ISO-like, take first 10 chars
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s.slice(0, 10);
}

function parseAmountToCents(v) {
  if (v === null || v === undefined || v === "") return 0;
  // Remove thousands separators/spaces; keep leading '-' if present
  const n = Number.parseFloat(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Robustly parse amount for common CSV shapes:
 *  - Amount / amount
 *  - Credit/Debit or credit/debit (net = credit - debit)
 *  Returns integer cents (can be negative).
 */
function parseRowAmountCents(r) {
  if (r.Amount !== undefined || r.amount !== undefined) {
    return parseAmountToCents(r.Amount ?? r.amount);
  }
  const hasCD =
    r.Credit !== undefined || r.credit !== undefined || r.Debit !== undefined || r.debit !== undefined;
  if (hasCD) {
    const c = r.Credit ?? r.credit ?? 0;
    const d = r.Debit ?? r.debit ?? 0;
    return parseAmountToCents(c) - parseAmountToCents(d);
  }
  // Fallback: any lone "amount-like" column (avoiding credit/debit)
  for (const k of Object.keys(r)) {
    if (/amount/i.test(k) && !/credit|debit/i.test(k)) {
      return parseAmountToCents(r[k]);
    }
  }
  return 0;
}

// --- controllers -----------------------------------------------------------

/**
 * Import a bank CSV as bank_statement_lines for a given bankAccountId.
 * - Requires a concrete tenant (req.sessionId !== null).
 * - Verifies bank account belongs to that tenant.
 * - Stamps session_id on each inserted row.
 * - Wraps inserts in a transaction for atomicity.
 */
export async function importBankCSV(req, res) {
  let began = false;
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId;
    if (sid === null) {
      // Writes must be scoped to a single workspace
      return res.status(400).json({ ok: false, error: "Workspace required for import." });
    }

    const { bankAccountId } = req.body || {};
    if (!bankAccountId)
      return res.status(400).json({ ok: false, error: "bankAccountId is required" });

    // Ensure the bank account exists **and** belongs to this workspace
    const ba = await query(
      `SELECT id FROM bank_accounts WHERE id = $2 AND ($1 IS NULL OR session_id = $1)`,
      [sid, bankAccountId]
    );
    if (!ba.rows?.length) {
      return res.status(404).json({ ok: false, error: "Bank account not found in this workspace" });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const csv = fs.readFileSync(file.path, "utf8");
    const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

    if (!rows.length) {
      return res.json({ ok: true, imported: 0 });
    }

    await query("BEGIN");
    began = true;

    let count = 0;
    for (const r of rows) {
      // Expected columns are flexible: Date, Narration, Amount | Credit/Debit
      const rawDate =
        r.Date || r.date || r["Value Date"] || r["value_date"] || r["Txn Date"] || r["txn_date"];
      const narration = (r.Narration || r.narration || r.Description || r.description || "").trim();
      const amount_cents = parseRowAmountCents(r);
      const id = crypto.randomUUID();

      // Insert with session_id stamped
      await query(
        `INSERT INTO bank_statement_lines
           (id, session_id, bank_account_id, value_date, narration, amount_cents, imported_file_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8,'unmatched'))`,
        [id, sid, bankAccountId, normalizeDateLike(rawDate), narration, amount_cents, file.filename, null]
      );
      count++;
    }

    await query("COMMIT");
    began = false;

    return res.json({ ok: true, imported: count });
  } catch (err) {
    if (began) {
      try { await query("ROLLBACK"); } catch (_) {}
    }
    console.error("importBankCSV error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Suggest ledger matches for unmatched bank lines.
 * - Reads tolerate admin "ALL" scope.
 * - When ALL is used, we derive the effective scope from the bank account's session_id,
 *   so suggestions are consistent and not cross-tenant by accident.
 */
export async function suggestions(req, res) {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const reqSid = req.sessionId; // can be string or null ("ALL")

    const { bankAccountId, dateFrom, dateTo } = req.query || {};
    if (!bankAccountId)
      return res.status(400).json({ ok: false, error: "bankAccountId is required" });

    // Load the bank account; if request is single-tenant, enforce it.
    // If request is ALL, use the account's actual session_id as the scope for this operation.
    const ba = await query(
      `SELECT id, session_id
         FROM bank_accounts
        WHERE id = $2
          AND ($1 IS NULL OR session_id = $1)`,
      [reqSid, bankAccountId]
    );
    if (!ba.rows?.length) {
      return res.status(404).json({ ok: false, error: "Bank account not found for this scope" });
    }
    const scopeSid = reqSid ?? ba.rows[0].session_id;

    // Fetch unmatched bank lines for this account within scope
    const b = await query(
      `SELECT *
         FROM bank_statement_lines
        WHERE bank_account_id = $2
          AND ($1 IS NULL OR session_id = $1)
          AND (status IS NULL OR status = 'unmatched')
          AND (value_date BETWEEN COALESCE($3,'1900-01-01') AND COALESCE($4,'2999-12-31'))
        ORDER BY value_date ASC, id ASC`,
      [scopeSid, bankAccountId, dateFrom || null, dateTo || null]
    );

    // Fetch candidate ledger entries in the same scope and date window
    const le = await query(
      `SELECT id, transaction_date, narration, debit_account, credit_account, amount_cents
         FROM ledger_entries
        WHERE ($1 IS NULL OR session_id = $1)
          AND transaction_date BETWEEN COALESCE($2,'1900-01-01') AND COALESCE($3,'2999-12-31')`,
      [scopeSid, dateFrom || null, dateTo || null]
    );

    const out = b.rows.map((bl) => {
      const ranked = rankCandidates(bl, le.rows, 5).slice(0, 3);
      return { bankLineId: bl.id, candidates: ranked };
    });

    return res.json({ ok: true, suggestions: out });
  } catch (err) {
    console.error("suggestions error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Confirm a bank-line ↔ ledger-entry match.
 * - Requires a concrete tenant (req.sessionId !== null).
 * - Validates both records belong to the same tenant.
 */
export async function confirmMatch(req, res) {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId;
    if (sid === null) {
      return res.status(400).json({ ok: false, error: "Workspace required to confirm match." });
    }

    const { bankLineId, ledgerEntryId } = req.body || {};
    if (!bankLineId || !ledgerEntryId)
      return res
        .status(400)
        .json({ ok: false, error: "bankLineId and ledgerEntryId are required" });

    // Ensure bank statement line exists in this workspace
    const bl = await query(
      `SELECT id FROM bank_statement_lines WHERE id = $2 AND ($1 IS NULL OR session_id = $1)`,
      [sid, bankLineId]
    );
    if (!bl.rows?.length) {
      return res.status(404).json({ ok: false, error: "Bank statement line not found in this workspace" });
    }

    // Ensure ledger entry exists in this workspace
    const led = await query(
      `SELECT id FROM ledger_entries WHERE id = $2 AND ($1 IS NULL OR session_id = $1)`,
      [sid, ledgerEntryId]
    );
    if (!led.rows?.length) {
      return res.status(404).json({ ok: false, error: "Ledger entry not found in this workspace" });
    }

    // Update within the same tenant
    const result = await query(
      `UPDATE bank_statement_lines
          SET matched_ledger_id = $2, status = 'matched'
        WHERE id = $3
          AND ($1 IS NULL OR session_id = $1)`,
      [sid, ledgerEntryId, bankLineId]
    );

    const changed = result?.changes ?? result?.rowCount ?? 0;
    if (!changed) {
      return res.status(404).json({ ok: false, error: "Bank statement line not found or not updated" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("confirmMatch error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
