/**
 * Funds & Facility Guard (preview-time)
 * Enforces that outflows on Cash/Bank/Loan ledgers do not exceed available headroom
 * as of the transaction date, honoring OD/OCC/LIMIT_ONLY and LOAN facilities.
 *
 * Works on SQLite and Postgres, tenant-scoped via sessionId, and respects preview holds.
 */

import { query } from "../../../../services/db.js"; // <-- correct relative path (4 levels up)
import { CODES } from "../../codes.js";
import { err } from "../../result.js";

const OK = (code, message, meta = null) => ({ code, message, level: "info", ...(meta ? { meta } : {}) });

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const asISODate = (s) => (s ? String(s).slice(0, 10) : new Date().toISOString().slice(0, 10));
const nowISO = () => new Date().toISOString();

// Treat names that contain these words as payment instruments.
// Facilities can still force checks even if the name doesn't match.
const INSTRUMENT_RE = /bank|cash|loan/i;

/** Running balance (Dr - Cr) as of date (inclusive), tenant-scoped. */
async function balanceAsOf(sessionId, account, dateISO) {
  // Prefer amount_cents (live schema); if that fails (legacy DB), fall back to amount.
  const SQL_CENTS = `
    SELECT
      COALESCE(SUM(CASE WHEN debit_account  = $1 THEN amount_cents ELSE 0 END),0)
    - COALESCE(SUM(CASE WHEN credit_account = $1 THEN amount_cents ELSE 0 END),0) AS bal_cents
    FROM ledger_entries
    WHERE transaction_date <= $2
      AND ($3 IS NULL OR session_id = $3)
  `;
  const SQL_AMOUNT = `
    SELECT
      COALESCE(SUM(CASE WHEN debit_account  = $1 THEN CAST(ROUND(amount*100.0) AS INTEGER) ELSE 0 END),0)
    - COALESCE(SUM(CASE WHEN credit_account = $1 THEN CAST(ROUND(amount*100.0) AS INTEGER) ELSE 0 END),0) AS bal_cents
    FROM ledger_entries
    WHERE transaction_date <= $2
      AND ($3 IS NULL OR session_id = $3)
  `;

  try {
    const { rows } = await query(SQL_CENTS, [account, dateISO, sessionId]);
    return Number(rows?.[0]?.bal_cents ?? 0);
  } catch (_e1) {
    try {
      const { rows } = await query(SQL_AMOUNT, [account, dateISO, sessionId]);
      return Number(rows?.[0]?.bal_cents ?? 0);
    } catch (_e2) {
      return 0;
    }
  }
}

/** Facility (if any) applicable on date; returns { facility_type, limit_cents } or null. */
async function getFacility(sessionId, account, dateISO) {
  const sql = `
    SELECT facility_type, limit_cents
      FROM account_facilities
     WHERE primary_account = $1
       AND ($2 IS NULL OR session_id = $2)
       AND (valid_from IS NULL OR valid_from <= $3)
       AND (valid_to   IS NULL OR valid_to   >= $3)
     LIMIT 1
  `;
  try {
    const { rows } = await query(sql, [account, sessionId, dateISO]);
    if (!rows || !rows[0]) return null;
    return {
      facility_type: String(rows[0].facility_type || "").toUpperCase(),
      limit_cents: Number(rows[0].limit_cents || 0)
    };
  } catch {
    return null;
  }
}

/** Active preview holds for (account,date), tenant-scoped. */
async function holdsOnDate(sessionId, account, dateISO) {
  const sql = `
    SELECT COALESCE(SUM(amount_cents),0) AS held
      FROM funds_holds
     WHERE account = $1
       AND hold_date = $2
       AND ($3 IS NULL OR session_id = $3)
       AND expires_at > $4
  `;
  try {
    const { rows } = await query(sql, [account, dateISO, sessionId, nowISO()]);
    return Number(rows?.[0]?.held || 0);
  } catch {
    // If holds table doesn't exist, treat as zero held.
    return 0;
  }
}

/**
 * Compute available headroom for an outflow from `account` on `dateISO`.
 * - With LOAN facility: available = max(0, limit - outstandingLoan) - holds
 * - With OD/OCC/LIMIT_ONLY facility (or no facility): available = balance + limit - holds
 */
async function availableHeadroom(sessionId, account, dateISO) {
  const bal = await balanceAsOf(sessionId, account, dateISO); // Dr - Cr
  const fac = await getFacility(sessionId, account, dateISO);
  const held = await holdsOnDate(sessionId, account, dateISO);

  if (fac && fac.facility_type === "LOAN") {
    // Loan is a liability; outstanding appears as credit (negative Dr-Cr).
    const outstanding = Math.max(0, -bal);
    const limit = Math.max(0, fac.limit_cents || 0);
    const headroom = Math.max(0, limit - outstanding);
    return headroom - held; // do not add bank balance here for LOAN
  }

  // OD/OCC/LIMIT_ONLY or no facility:
  const limit = fac ? Math.max(0, fac.limit_cents || 0) : 0;
  return (bal + limit) - held;
}

export default async function cashBankFacilities(ctx) {
  const out = { errors: [], warnings: [], info: [] };
  const {
    journal = [],
    sessionId = null,
    docModel = {},
    policy = {},
    mode = "preview"
  } = ctx || {};

  const cfg = policy?.cashBank || { blockNegative: true };
  if (!cfg.blockNegative || !Array.isArray(journal) || journal.length === 0) return out;

  // Aggregate net outflow per (account, date)
  const deltas = new Map(); // key = `${account}|${dateISO}` -> cents (Cr - Dr)
  const defaultDate = asISODate(docModel?.date || docModel?.transaction_date || undefined);
  for (const l of journal) {
    const acct = String(l?.account || "").trim();
    if (!acct) continue;
    const dateISO = asISODate(l?.date || defaultDate);
    const key = `${acct}|${dateISO}`;
    const drC = toCents(l?.debit || 0);
    const crC = toCents(l?.credit || 0);
    deltas.set(key, (deltas.get(key) || 0) + (crC - drC));
  }

  // Evaluate each (account,date) that has a positive outflow
  for (const [key, outflow] of deltas) {
    if (outflow <= 0) continue; // inflow or net zero is always fine
    const [account, dateISO] = key.split("|");

    // Skip non-instruments with no facility configured (performance & correctness)
    let fac = null;
    const looksInstrument = INSTRUMENT_RE.test(account);
    if (!looksInstrument) {
      fac = await getFacility(sessionId, account, dateISO);
      if (!fac) continue; // not an instrument and no facility: don't enforce
    }

    const available = await availableHeadroom(sessionId, account, dateISO);

    if (outflow > available) {
      const short = outflow - available;
      out.errors.push(
        err(
          CODES?.BANK_CASH_INSUFFICIENT || "BANK_CASH_INSUFFICIENT",
          `Insufficient funds in ${account} as of ${dateISO}. Available ₹${(available/100).toFixed(2)}; required ₹${(outflow/100).toFixed(2)}; short ₹${(short/100).toFixed(2)}.`,
          null,
          { account, date: dateISO, available_cents: available, required_cents: outflow, short_cents: short }
        )
      );
    }
  }

  if (!out.errors.length && mode === "preview") {
    out.info.push(OK("FUNDS_OK", "Funds and facility headroom check passed."));
  }

  return out;
}
