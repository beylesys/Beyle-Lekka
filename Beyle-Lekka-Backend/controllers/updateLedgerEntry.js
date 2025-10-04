// controllers/updateLedgerEntry.js
import { query } from "../services/db.js";
import { ensureLedgerExists } from "../utils/coaService.js";

/**
 * POST /api/ledger/update
 * Body: { id, transaction_date, debit_account, credit_account, amount, narration }
 * - amount is in ₹ (units); we store paise in amount_cents when present.
 */

function toUnits(n) {
  const cleaned = Number.parseFloat(String(n).replace(/[^\d.-]/g, ""));
  return Number.isFinite(cleaned) ? cleaned : NaN;
}

// --- column detection (PG + SQLite), cached ---------------------------------
let _ledCols = null;

function safeIdent(t) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(t || ""))) {
    throw new Error(`Invalid identifier: ${t}`);
  }
  return t;
}

async function columnNames(table) {
  // Try Postgres information_schema first
  try {
    const r = await query(
      `SELECT lower(column_name) AS name
         FROM information_schema.columns
        WHERE lower(table_name) = lower($1)`,
      [table]
    );
    if (Array.isArray(r.rows)) return r.rows.map(x => x.name);
  } catch {}
  // Fallback: SQLite PRAGMA (cannot param-bind identifiers)
  try {
    const t = safeIdent(table);
    const r2 = await query(`PRAGMA table_info(${t})`);
    if (Array.isArray(r2.rows)) {
      return r2.rows.map(x => String(x.name || x.NAME).toLowerCase());
    }
  } catch {}
  return [];
}

async function detectLedgerColumns() {
  if (_ledCols) return _ledCols;
  const cols = await columnNames("ledger_entries");
  _ledCols = {
    hasAmountCents: cols.includes("amount_cents"),
    hasAmount: cols.includes("amount"),
  };
  return _ledCols;
}

// -----------------------------------------------------------------------------

export const updateLedgerEntry = async (req, res) => {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId;
    if (sid === null) {
      // Writes must be tied to a single workspace (no admin ALL scope)
      return res.status(400).json({ ok: false, error: "Workspace required to update ledger entry." });
    }

    const {
      id,
      transaction_date,
      debit_account,
      credit_account,
      amount,
      narration,
    } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "id is required" });

    // Basic validation (DB may also enforce via trigger)
    const date = String(transaction_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "transaction_date must be YYYY-MM-DD" });
    }

    const debit = String(debit_account || "").trim();
    const credit = String(credit_account || "").trim();
    if (!debit || !credit) {
      return res
        .status(400)
        .json({ ok: false, error: "debit_account and credit_account are required" });
    }
    if (debit.toLowerCase() === credit.toLowerCase()) {
      return res
        .status(400)
        .json({ ok: false, error: "debit_account and credit_account cannot be the same" });
    }

    const units = toUnits(amount);
    if (!Number.isFinite(units) || units <= 0) {
      return res.status(400).json({ ok: false, error: "amount must be a positive number" });
    }
    const amount_cents = Math.round(units * 100);

    // Ensure COA accounts exist in THIS workspace (helps reports immediately)
    await ensureLedgerExists(debit, sid);
    await ensureLedgerExists(credit, sid);

    // Build dynamic SET clause based on available columns
    const { hasAmountCents, hasAmount } = await detectLedgerColumns();

    const baseParams = [sid, id]; // $1 = sid, $2 = id
    const sets = [];
    const params = [];

    const pushSet = (col, val) => {
      const idx = baseParams.length + params.length + 1; // starts at $3
      sets.push(`${col} = $${idx}`);
      params.push(val);
    };

    pushSet("transaction_date", date);
    pushSet("debit_account", debit);
    pushSet("credit_account", credit);

    if (hasAmountCents) pushSet("amount_cents", amount_cents);
    if (hasAmount)      pushSet("amount", units);

    pushSet("narration", narration ?? "");

    const sql = `
      UPDATE ledger_entries
         SET ${sets.join(",\n             ")}
       WHERE id = $2
         AND ($1 IS NULL OR session_id = $1)
    `;

    const result = await query(sql, [...baseParams, ...params]);
    const changed = result?.changes ?? result?.rowCount ?? 0;

    if (!changed) {
      // Not found in this workspace (or no-op update)
      return res.status(404).json({ ok: false, error: "Ledger entry not found" });
    }
    return res.status(200).json({ ok: true, updated: changed });
  } catch (err) {
    console.error("updateLedgerEntry error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Failed to update ledger entry" });
  }
};
