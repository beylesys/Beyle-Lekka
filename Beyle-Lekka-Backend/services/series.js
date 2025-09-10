// services/series.js
import { query } from "./db.js";

/**
 * Schema:
 *  document_series(
 *    doc_type TEXT PRIMARY KEY,   -- 'invoice' | 'receipt' | 'voucher'
 *    prefix   TEXT NOT NULL,      -- 'INV' | 'RCT' | 'PV'
 *    year     INTEGER NOT NULL,   -- e.g. 2025
 *    curr     INTEGER NOT NULL    -- last issued sequential number for that year
 *  )
 */

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS document_series (
  doc_type TEXT PRIMARY KEY,
  prefix   TEXT NOT NULL,
  year     INTEGER NOT NULL,
  curr     INTEGER NOT NULL
);
`;

// Basic prefix map
function prefixFor(docType) {
  if (docType === "invoice") return "INV";
  if (docType === "receipt") return "RCT";
  // treat both 'voucher' and 'payment_voucher' as vouchers
  return "PV";
}

// Pad number to 5 digits
function pad5(n) {
  const s = String(n);
  return s.length >= 5 ? s : "00000".slice(s.length) + s;
}

/**
 * Ensures table exists (SQLite).
 */
async function ensureTable() {
  await query(TABLE_SQL);
}

/**
 * Atomically increments and returns the next number for a docType.
 * SQLite-safe: uses BEGIN IMMEDIATE transaction; zero "FOR UPDATE" usage.
 *
 * @param {"invoice"|"receipt"|"voucher"|"payment_voucher"} rawType
 * @returns {Promise<string>} e.g. "INV-2025-00001"
 */
export async function getNextNumber(rawType) {
  const docType = rawType === "payment_voucher" ? "voucher" : rawType;
  const year = new Date().getFullYear();
  const prefix = prefixFor(docType);

  await ensureTable();

  try {
    // Start write transaction that blocks concurrent writers but allows readers.
    await query("BEGIN IMMEDIATE");

    // Read current row (if any)
    const sel = await query(
      "SELECT doc_type, prefix, year, curr FROM document_series WHERE doc_type = ?",
      [docType]
    );
    const row = sel?.rows?.[0] || null;

    if (!row) {
      // First time for this doc_type → insert base row with curr=0
      await query(
        `INSERT INTO document_series (doc_type, prefix, year, curr)
         VALUES (?, ?, ?, 0)`,
        [docType, prefix, year]
      );
    } else if (row.year !== year || row.prefix !== prefix) {
      // New year (or prefix changed) → reset counter for this year
      await query(
        `UPDATE document_series
           SET year = ?, prefix = ?, curr = 0
         WHERE doc_type = ?`,
        [year, prefix, docType]
      );
    }

    // Increment and fetch new value
    await query(
      `UPDATE document_series
          SET curr = curr + 1
        WHERE doc_type = ?`,
      [docType]
    );

    const after = await query(
      "SELECT prefix, year, curr FROM document_series WHERE doc_type = ?",
      [docType]
    );
    const final = after?.rows?.[0];
    if (!final) {
      throw new Error("Series row not found after update.");
    }

    const number = `${final.prefix}-${final.year}-${pad5(final.curr)}`;

    await query("COMMIT");
    return number;
  } catch (err) {
    try { await query("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

/**
 * Optional helper if you ever want to peek at the current counter without incrementing.
 */
export async function peekSeries(rawType) {
  const docType = rawType === "payment_voucher" ? "voucher" : rawType;
  await ensureTable();
  const r = await query(
    "SELECT prefix, year, curr FROM document_series WHERE doc_type = ?",
    [docType]
  );
  return r?.rows?.[0] || null;
}
