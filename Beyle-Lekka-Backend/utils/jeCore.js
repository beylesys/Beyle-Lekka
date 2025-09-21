// utils/jeCore.js
import { query } from "../services/db.js";

/* ---------- utilities ---------- */
const TODAY = new Date().toISOString().slice(0, 10);
const isYYYYMMDD = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const toCents = (v) => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.round(v * 100);
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const centsToUnits = (c) => Math.round(c) / 100;

export function buildLedgerView(rows) {
  const header = `Date | Account | Debit | Credit | Narration`;
  const sep    = `---- | ------- | ----- | ------ | ---------`;
  const lines  = rows.map(r =>
    `${r.date} | ${r.account} | ${Number(r.debit).toFixed(2)} | ${Number(r.credit).toFixed(2)} | ${r.narration || ""}`
  );
  return [header, sep, ...lines].join("\n");
}

/* ---------- COA existence ---------- */
async function accountExists(nameOrCode) {
  const name = String(nameOrCode || "").trim();
  if (!name) return false;
  try {
    const { rows } = await query(
      "SELECT 1 FROM chart_of_accounts WHERE (account_code = $1 OR name = $1) AND is_active = 1 LIMIT 1",
      [name]
    );
    return rows.length > 0;
  } catch {
    // table may not exist yet; treat as missing but not fatal
    return false;
  }
}

/* ---------- SHAPE ADAPTER: accepts pair-style or single-line ---------- */
function coerceToSingleLine(journal) {
  if (!Array.isArray(journal)) return [];

  // Heuristic: if â‰¥50% rows look like {debit_account, credit_account, amount}, expand them
  let pairCount = 0;
  for (const l of journal) {
    if (l && (l.debit_account || l.debitAccount) && (l.credit_account || l.creditAccount) && ("amount" in l || "value" in l)) {
      pairCount++;
    }
  }

  if (pairCount >= Math.ceil(journal.length * 0.5)) {
    const out = [];
    for (const l of journal) {
      if (!l) continue;

      const debitAcc  = String(l.debit_account || l.debitAccount || "").trim();
      const creditAcc = String(l.credit_account || l.creditAccount || "").trim();
      const amtRaw    = l.amount ?? l.value;
      const cents     = toCents(amtRaw);
      const date      = String(l.date || l.transaction_date || "").trim();
      const narration = String(l.narration || "").trim();

      if (!debitAcc || !creditAcc || !Number.isFinite(cents) || cents <= 0) continue;

      out.push({ account: debitAcc,  debit: centsToUnits(cents), credit: 0,                date, narration });
      out.push({ account: creditAcc, debit: 0,                 credit: centsToUnits(cents), date, narration });
    }
    return out;
  }

  // Otherwise assume it is already single-line; normalize account key if needed
  return journal.map(l => {
    if (!l) return l;
    if (!("account" in l)) {
      const acc = l.account_name || l.acc || l.ledger || l.name || "";
      return { ...l, account: acc };
    }
    return l;
  });
}

/* ---------- Validate & normalize for preview ---------- */
/**
 * Accepts:
 *  A) [{ account, debit, credit, date, narration }]  (single-line)
 *  B) [{ debit_account, credit_account, amount, date, narration }] (pair-style)
 *
 * Returns: { ok, errors[], warnings[], normalized[], newAccounts[], totalsCents:{debit,credit} }
 */
export async function validateAndPreparePreview(journal, opts = {}) {
  const { allowFutureDates = false } = opts;
  const errors = [];
  const warnings = [];
  const normalized = [];

  // NEW: adapt shapes first
  const items = coerceToSingleLine(journal);

  if (!Array.isArray(items) || items.length < 2) {
    return { ok: false, errors: ["journal must have at least two lines"], warnings, normalized: [], newAccounts: [], totalsCents:{debit:0,credit:0} };
  }

  for (let i = 0; i < items.length; i++) {
    const line = items[i] || {};
    const account = String(line.account || "").trim().replace(/\s+/g, " ");
    const date = String(line.date || line.transaction_date || "").trim();
    const narration = String(line.narration || "").trim();
    const debitC = toCents(line.debit || 0);
    const creditC = toCents(line.credit || 0);

    if (!account) { errors.push(`row${i + 1}: account missing`); continue; }
    if (!isYYYYMMDD(date)) { errors.push(`row${i + 1}: date must be YYYY-MM-DD`); continue; }
    if (!allowFutureDates && date > TODAY) warnings.push(`row${i + 1}: future date ${date}`);
    if (!Number.isFinite(debitC) || !Number.isFinite(creditC)) { errors.push(`row${i + 1}: invalid amount`); continue; }

    const debitPos = debitC > 0, creditPos = creditC > 0;
    if ((debitPos && creditPos) || (!debitPos && !creditPos)) { errors.push(`row${i + 1}: exactly one of debit/credit must be > 0`); continue; }

    normalized.push({
      account,
      date,
      narration,
      debit: debitPos ? centsToUnits(debitC) : 0,
      credit: creditPos ? centsToUnits(creditC) : 0
    });
  }

  if (errors.length) {
    return { ok: false, errors, warnings, normalized: [], newAccounts: [], totalsCents:{debit:0,credit:0} };
  }

  // Balance in cents
  const totalD = normalized.reduce((s, r) => s + toCents(r.debit), 0);
  const totalC = normalized.reduce((s, r) => s + toCents(r.credit), 0);
  if (totalD !== totalC) {
    errors.push(`not balanced: debit=${(totalD/100).toFixed(2)} credit=${(totalC/100).toFixed(2)}`);
    return { ok: false, errors, warnings, normalized: [], newAccounts: [], totalsCents:{debit:totalD,credit:totalC} };
  }

  // COA presence
  const uniq = Array.from(new Set(normalized.map(r => r.account)));
  const existence = await Promise.all(uniq.map(a => accountExists(a)));
  const newAccounts = uniq.filter((_, idx) => existence[idx] === false);

  return { ok: true, errors, warnings, normalized, newAccounts, totalsCents:{debit:totalD,credit:totalC} };
}

/* ---------- Pair into DB rows ---------- */
export function pairForLedger(normalized) {
  const debits  = [];
  const credits = [];

  for (const line of normalized) {
    const acc = line.account.trim();
    const date = line.date;
    const dC = toCents(line.debit || 0);
    const cC = toCents(line.credit || 0);
    if (dC > 0) debits.push({ account: acc, cents: dC, narration: line.narration, date });
    if (cC > 0) credits.push({ account: acc, cents: cC, narration: line.narration, date });
  }

  const sumD = debits.reduce((s, d) => s + d.cents, 0);
  const sumC = credits.reduce((s, c) => s + c.cents, 0);
  if (sumD !== sumC || sumD === 0) return [];

  const out = [];
  let i = 0, j = 0;

  const avoidSameAccount = () => {
    const d = debits[i], c = credits[j];
    if (!d || !c) return true;
    if (d.account !== c.account) return true;

    let k = j + 1;
    while (k < credits.length && (credits[k].cents === 0 || credits[k].account === d.account)) k++;
    if (k < credits.length) { const t = credits[j]; credits[j] = credits[k]; credits[k] = t; return true; }

    let k2 = i + 1;
    while (k2 < debits.length && (debits[k2].cents === 0 || debits[k2].account === c.account)) k2++;
    if (k2 < debits.length) { const t2 = debits[i]; debits[i] = debits[k2]; debits[k2] = t2; return true; }

    return false;
  };

  while (i < debits.length && j < credits.length) {
    while (i < debits.length && debits[i].cents === 0) i++;
    while (j < credits.length && credits[j].cents === 0) j++;
    if (i >= debits.length || j >= credits.length) break;

    if (!avoidSameAccount()) {
      // Let DB trigger catch if same-account posting is disallowed
    }

    const d = debits[i];
    const c = credits[j];
    const m = Math.min(d.cents, c.cents);

    out.push({
      debit_account: d.account,
      credit_account: c.account,
      amount: centsToUnits(m),
      narration: d.narration || c.narration || "",
      transaction_date: d.date || c.date || TODAY
    });

    d.cents -= m;
    c.cents -= m;
    if (d.cents === 0) i++;
    if (c.cents === 0) j++;
  }

  return out;
}
