// utils/hash.js
// ESM version (Node 22). Backward-compatible normalizer.
// Public API: hashJournalPairs(pairs), stablePairsString(pairs)

import { createHash } from "crypto";

/** Normalize whitespace (collapse runs to single space) and trim. */
function normText(s) {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

/** Lowercase, collapse whitespace. */
function normKey(s) {
  return normText(s).toLowerCase();
}

/** Normalize date to YYYY-MM-DD (UTC) without throwing on bad inputs. */
function normDate(d) {
  if (!d) return "";
  try {
    const iso = new Date(d).toISOString();
    return iso.slice(0, 10);
  } catch {
    // Accept already-ISO-ish strings; otherwise, empty
    const s = String(d).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  }
}

/** Try a list of property names; return the first non-null/undefined. */
function pick(obj, names = []) {
  for (const n of names) {
    if (obj != null && obj[n] != null) return obj[n];
  }
  return undefined;
}

/** Normalize a single pair/line to a stable pipe-separated string. */
function normalizePair(p) {
  // Support both legacy and current shapes
  const date = pick(p, ["date", "transaction_date", "transactionDate"]);
  const debit = pick(p, ["debit", "debit_account", "debitAccount"]);
  const credit = pick(p, ["credit", "credit_account", "creditAccount"]);
  const narration = pick(p, ["narration", "description"]);

  // Prefer amount_cents when present; else normalize amount (2dp) → cents
  let amountCents = pick(p, ["amount_cents", "amountCents"]);
  if (amountCents == null) {
    const amt = pick(p, ["amount", "amt"]);
    if (amt != null && amt !== "") {
      const n = Number.parseFloat(String(amt));
      amountCents = Number.isFinite(n) ? Math.round(n * 100) : "";
    } else {
      amountCents = "";
    }
  }

  return [
    normDate(date),
    normKey(debit),
    normKey(credit),
    String(amountCents ?? ""),
    normText(narration),
  ].join("|");
}

/** Stable stringify of an array by sorting normalized lines. */
export function stablePairsString(pairs) {
  const rows = (Array.isArray(pairs) ? pairs : []).map(normalizePair);
  rows.sort(); // lexicographic sort is stable for normalized row strings
  return rows.join("||");
}

/** Hex SHA-256 for a string. */
function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** Compute a content hash for JE pairs. */
export function hashJournalPairs(pairs) {
  return sha256(stablePairsString(pairs));
}

export default { hashJournalPairs, stablePairsString };
