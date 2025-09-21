// utils/coaService.js (enhanced to eradicate duplicate ledger names at the source)
// Grounded in your repo; keeps schema/seed logic but adds canonicalization and
// a startup sweep to normalize legacy ledger names stored in `ledger_entries`.

import { query } from "../services/db.js";

/**
 * Baseline Indian CoA (broad but sensible). Types must be one of:
 *   asset | liability | equity | income | expense
 * normal_balance: debit | credit
 */
const BASE_COA = [
  // Equity
  ["3000", "Share Capital", "equity", "credit"],
  ["3100", "Capital Account", "equity", "credit"],
  ["3200", "Reserves & Surplus", "equity", "credit"],
  ["3300", "Drawings", "equity", "debit"],

  // Assets – Current
  ["1000", "Bank", "asset", "debit"],
  ["1001", "Bank – HDFC", "asset", "debit"],
  ["1002", "Bank – SBI", "asset", "debit"],
  ["1010", "Cash", "asset", "debit"],
  ["1011", "Petty Cash", "asset", "debit"],
  ["1100", "Debtors (Accounts Receivable)", "asset", "debit"],
  ["1110", "Advance to Suppliers", "asset", "debit"],
  ["1120", "Prepaid Expenses", "asset", "debit"],
  ["1130", "Employee Advances", "asset", "debit"],
  ["1140", "TDS Receivable", "asset", "debit"],

  // Assets – Taxes (Input)
  ["1200", "GST Input (IGST)", "asset", "debit"],
  ["1210", "GST Input (CGST)", "asset", "debit"],
  ["1220", "GST Input (SGST)", "asset", "debit"],
  ["1230", "GST Refund Receivable", "asset", "debit"],

  // Assets – Non-Current
  ["1500", "Fixed Assets", "asset", "debit"],
  ["1501", "Furniture & Fixtures", "asset", "debit"],
  ["1502", "Computers & Peripherals", "asset", "debit"],
  ["1503", "Office Equipment", "asset", "debit"],
  ["1510", "Accumulated Depreciation", "asset", "credit"],

  // Liabilities – Current
  ["2000", "Creditors (Accounts Payable)", "liability", "credit"],
  ["2010", "Salary Payable", "liability", "credit"],
  ["2020", "GST Payable (IGST)", "liability", "credit"],
  ["2021", "GST Payable (CGST)", "liability", "credit"],
  ["2022", "GST Payable (SGST)", "liability", "credit"],
  ["2030", "GST RCM Payable", "liability", "credit"],
  ["2040", "TDS Payable", "liability", "credit"],
  ["2050", "Professional Tax Payable", "liability", "credit"],
  ["2060", "PF Payable", "liability", "credit"],
  ["2061", "ESI Payable", "liability", "credit"],
  ["2070", "Unearned Revenue (Advances from Customers)", "liability", "credit"],

  // Liabilities – Non-Current
  ["2100", "Secured Loans", "liability", "credit"],
  ["2110", "Unsecured Loans", "liability", "credit"],

  // Income
  ["4000", "Sales", "income", "credit"],
  ["4010", "Sales – Goods", "income", "credit"],
  ["4020", "Sales – Services", "income", "credit"],
  ["4100", "Other Operating Income", "income", "credit"],
  ["4200", "Interest Income", "income", "credit"],
  ["4300", "Discount Received", "income", "credit"],
  ["4900", "Round-off (Income)", "income", "credit"],

  // Purchases & Direct Costs
  ["5000", "Purchases – Goods", "expense", "debit"],
  ["5010", "Purchases – Services", "expense", "debit"],
  ["5100", "Freight Inward", "expense", "debit"],
  ["5200", "Direct Wages", "expense", "debit"],
  ["5300", "Cost of Goods Sold", "expense", "debit"],

  // Operating Expenses
  ["6000", "Salaries", "expense", "debit"],
  ["6010", "Rent", "expense", "debit"],
  ["6020", "Electricity", "expense", "debit"],
  ["6030", "Telephone & Internet", "expense", "debit"],
  ["6040", "Office Expenses", "expense", "debit"],
  ["6050", "Repairs & Maintenance", "expense", "debit"],
  ["6060", "Travelling & Conveyance", "expense", "debit"],
  ["6070", "Professional Fees", "expense", "debit"],
  ["6080", "Bank Charges", "expense", "debit"],
  ["6090", "Printing & Stationery", "expense", "debit"],
  ["6100", "Advertising & Marketing", "expense", "debit"],
  ["6110", "Training & Recruitment", "expense", "debit"],
  ["6120", "Insurance", "expense", "debit"],
  ["6130", "Miscellaneous Expenses", "expense", "debit"],
  ["6900", "Round-off (Expense)", "expense", "debit"],

  // Taxes (Output)
  ["7000", "GST Output (IGST)", "liability", "credit"],
  ["7010", "GST Output (CGST)", "liability", "credit"],
  ["7020", "GST Output (SGST)", "liability", "credit"],

  // TDS / Statutory
  ["7100", "TDS Payable (194C)", "liability", "credit"],
  ["7110", "TDS Payable (194J)", "liability", "credit"],
];

/* ----------------- helpers ----------------- */

function normalizeDashes(s = "") {
  // Replace figure dash, en dash, em dash, minus → hyphen
  return String(s).replace(/[\u2012\u2013\u2014\u2212]/g, "-");
}

function normalizeSpaces(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function normKey(s = "") {
  // Lowercase + normalized dashes/spaces for comparisons
  return normalizeSpaces(normalizeDashes(s)).toLowerCase();
}

function namesEqual(a = "", b = "") {
  return normKey(a) === normKey(b);
}

function splitSub(name) {
  const normalized = normalizeDashes(name);
  const parts = normalized.split(/\s*[-:]\s*/);
  if (parts.length >= 2) {
    return { parent: parts[0].trim(), child: parts.slice(1).join(" - ").trim() };
  }
  return null;
}

async function codeExists(code) {
  const { rows } = await query(
    "SELECT 1 FROM chart_of_accounts WHERE account_code = $1 LIMIT 1",
    [code]
  );
  return rows.length > 0;
}

async function nextFreeCode(maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const code = String(Math.floor(Math.random() * 9000) + 1000);
    if (!(await codeExists(code))) return code;
  }
  // Fallback: timestamp tail (still reasonably unique)
  return String((Date.now() % 100000) + 10000);
}

/* ---------- Canonicalization ---------- */

/**
 * Canonicalize a ledger name (pure, no DB lookups).
 * - Normalizes whitespace & dashes.
 * - Maps common synonyms to the canonical names used in BASE_COA.
 * - Standardizes A/R & A/P parent labels.
 */
function canonicalizeLedgerName(raw = "") {
  let n0 = normalizeSpaces(normalizeDashes(raw));
  if (!n0) return n0;

  const low = n0.toLowerCase();

  // Bank / Cash
  if (/^bank( account| a\/c| acc| ac)?$/i.test(n0) || /^(current|savings)\s+account$/i.test(low)) {
    return "Bank";
  }
  if (/^cash( account| a\/c| acc| ac)?$/i.test(n0)) {
    return "Cash";
  }

  // GST Input (IGST/CGST/SGST)
  // Handles: "Input SGST", "SGST Input", "SGST Input Credit Account", "IGST ITC", etc.
  const tax = /(i|c|s)gst/.exec(low)?.[1];
  if (tax) {
    const slab = tax === "i" ? "IGST" : tax === "c" ? "CGST" : "SGST";
    if (/\b(input|itc)\b/.test(low)) return `GST Input (${slab})`;
    if (/\b(output|out)\b/.test(low)) return `GST Output (${slab})`;
    // "GST Payable" we leave as-is because BASE_COA explicitly has those ledgers too.
  }

  // A/R and A/P standardized parent labels when they are explicitly present
  // Any "Accounts Receivable - X" / "Debtors - X" → "Debtors (Accounts Receivable) - X"
  let m = low.match(/^(accounts\s*receivable|debtors)(?:\s*\(accounts\s*receivable\))?\s*[-:]\s*(.+)$/i);
  if (m) return `Debtors (Accounts Receivable) - ${normalizeSpaces(m[2])}`;

  // Any "Accounts Payable - X" / "Creditors - X" → "Creditors (Accounts Payable) - X"
  m = low.match(/^(accounts\s*payable|creditors)(?:\s*\(accounts\s*payable\))?\s*[-:]\s*(.+)$/i);
  if (m) return `Creditors (Accounts Payable) - ${normalizeSpaces(m[2])}`;

  return n0;
}

/**
 * Resolve to a canonical name with DB-assisted disambiguation for party ledgers.
 * If raw is a bare party name like "Mr X" and a canonical AR/AP sub-ledger already
 * exists for it, reuse that to avoid duplicates. Otherwise, return the pure canonical name.
 */
async function resolveCanonicalName(raw = "") {
  const pure = canonicalizeLedgerName(raw);
  if (!pure) return pure;

  // If the name already contains a parent-child pattern, we are done.
  const hasDash = /[-:]/.test(pure);
  const containsARAP =
    /\b(debtors|accounts receivable|creditors|accounts payable)\b/i.test(pure);
  if (hasDash && containsARAP) return pure;

  // Bare party names: if AR/AP sub-ledgers already exist, reuse them.
  // Prefer Accounts Receivable if both exist (conservative).
  const party = pure;
  // Check AR
  let rows = await query(
    "SELECT name FROM chart_of_accounts WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [`Debtors (Accounts Receivable) - ${party}`]
  );
  if (rows.rows?.length) return `Debtors (Accounts Receivable) - ${party}`;
  // Check AP
  rows = await query(
    "SELECT name FROM chart_of_accounts WHERE LOWER(name) = LOWER($1) LIMIT 1",
    [`Creditors (Accounts Payable) - ${party}`]
  );
  if (rows.rows?.length) return `Creditors (Accounts Payable) - ${party}`;

  return pure;
}

/**
 * Lookup a ledger by "normalized name" equality (case/space/dash-insensitive).
 * Falls back to exact name if normalized scan does not find a match.
 */
async function lookupByNormalizedName(name) {
  const { rows } = await query(
    "SELECT account_code, name FROM chart_of_accounts WHERE is_active = 1"
  );
  const key = normKey(name);
  for (const r of rows || []) {
    if (normKey(r.name) === key) return r;
  }
  // Fallback exact
  const ex = await query(
    "SELECT account_code, name FROM chart_of_accounts WHERE name = $1 AND is_active = 1 LIMIT 1",
    [name]
  );
  return (ex.rows || [])[0] || null;
}

/* ----------------- schema padding & seed ----------------- */

export async function ensureBaseCoA() {
  // Create table if missing (with parent_code in definition)
  await query(`
    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      account_code   TEXT PRIMARY KEY,
      name           TEXT NOT NULL UNIQUE,
      type           TEXT NOT NULL,
      normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
      is_active      INTEGER NOT NULL DEFAULT 1,
      parent_code    TEXT NULL
    )
  `);

  // Add parent_code if legacy table didn't have it
  try {
    const info = await query(`PRAGMA table_info('chart_of_accounts')`);
    const cols = info.rows || info;
    if (!Array.isArray(cols) || !cols.some(c => c.name === "parent_code")) {
      await query(`ALTER TABLE chart_of_accounts ADD COLUMN parent_code TEXT`);
      console.log("✅ Added missing column 'parent_code' to chart_of_accounts");
    }
  } catch (e) {
    console.warn("⚠️ Could not ensure 'parent_code' column:", e?.message || e);
  }

  // --- Deduplicate legacy data so we can build UNIQUE indexes safely ---

  // 1) Fix duplicate account_code values (keep first, reassign others)
  try {
    const dups = await query(`
      SELECT account_code, COUNT(*) AS c
      FROM chart_of_accounts
      GROUP BY account_code
      HAVING c > 1
    `);
    for (const r of dups.rows || []) {
      const code = r.account_code;
      const rows = await query(
        `SELECT rowid FROM chart_of_accounts WHERE account_code = $1 ORDER BY rowid`,
        [code]
      );
      const all = rows.rows || [];
      for (let i = 1; i < all.length; i++) { // skip the first row (keep it)
        const newCode = await nextFreeCode();
        await query(
          `UPDATE chart_of_accounts SET account_code = $1 WHERE rowid = $2`,
          [newCode, all[i].rowid]
        );
      }
    }
  } catch (e) {
    console.warn("⚠️ Could not dedupe duplicate account_code:", e?.message || e);
  }

  // 2) Fix duplicate names (keep first, rename others: "Name (2)", "Name (3)", ...)
  try {
    const dups = await query(`
      SELECT name, COUNT(*) AS c
      FROM chart_of_accounts
      GROUP BY name
      HAVING c > 1
    `);
    for (const r of dups.rows || []) {
      const base = r.name;
      const rows = await query(
        `SELECT rowid FROM chart_of_accounts WHERE name = $1 ORDER BY rowid`,
        [base]
      );
      const all = rows.rows || [];
      let suffix = 2;
      for (let i = 1; i < all.length; i++) {
        // find a free new name
        let newName;
        while (true) {
          newName = `${base} (${suffix++})`;
          const taken = await query(
            `SELECT 1 FROM chart_of_accounts WHERE name = $1 LIMIT 1`,
            [newName]
          );
          if (!(taken.rows || []).length) break;
        }
        await query(
          `UPDATE chart_of_accounts SET name = $1 WHERE rowid = $2`,
          [newName, all[i].rowid]
        );
      }
    }
  } catch (e) {
    console.warn("⚠️ Could not dedupe duplicate names:", e?.message || e);
  }

  // 3) Ensure unique indexes so ON CONFLICT works (legacy DBs may lack them)
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_coa_code ON chart_of_accounts(account_code)`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_coa_name ON chart_of_accounts(name)`);
  } catch (e) {
    console.warn("⚠️ Could not ensure unique indexes on chart_of_accounts:", e?.message || e);
  }

  // 4) Seed baseline rows — safer with INSERT OR IGNORE (handles code or name uniqueness)
  for (const [code, name, type, normal] of BASE_COA) {
    await query(
      `INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance, is_active)
       VALUES ($1,$2,$3,$4,1)`,
      [code, name, type, normal]
    );
  }

  // 5) One-time canonicalization sweep for legacy names in ledger_entries
  await canonicalizeExistingData();
}

/* ----------------- runtime creation / lookup ----------------- */

/** Create/find a ledger by name or code. Also handles "Parent – Child" creation. */
export async function ensureLedgerExists(nameOrCode, hint = {}) {
  const nameRaw = String(nameOrCode || "").trim();
  if (!nameRaw) return;

  // First canonicalize (with DB disambiguation for party names)
  const nameCanon = await resolveCanonicalName(nameRaw);

  // 1) Match by code OR normalized name
  try {
    // Code match
    const codeHit = await query(
      "SELECT account_code FROM chart_of_accounts WHERE account_code = $1 AND is_active = 1 LIMIT 1",
      [nameCanon]
    );
    if (codeHit.rows?.length) return codeHit.rows[0].account_code;

    // Name match (normalized)
    const found = await lookupByNormalizedName(nameCanon);
    if (found) return found.account_code;
  } catch {
    // table may not exist yet; continue
  }

  // 2) Parent – Child creation (standardize parent labels too)
  const parts = splitSub(nameCanon);
  if (parts) {
    let parent = parts.parent;
    const child = parts.child;

    // Standardize AR/AP parent names
    if (/^(accounts\s*receivable|debtors)/i.test(parent)) {
      parent = "Debtors (Accounts Receivable)";
    } else if (/^(accounts\s*payable|creditors)/i.test(parent)) {
      parent = "Creditors (Accounts Payable)";
    }

    // Find (or create) the parent first
    let p = await lookupByNormalizedName(parent);
    if (!p) {
      // create parent by looking up any matching base row or inferring type/normal
      const type = /receivable/i.test(parent) ? "asset" : /payable/i.test(parent) ? "liability" : (hint.type || "asset");
      const normal = type === "asset" ? "debit" : "credit";
      const pcode = await nextFreeCode();
      await query(
        `INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance, is_active, parent_code)
         VALUES ($1,$2,$3,$4,1,NULL)`,
        [pcode, parent, type, normal]
      );
      p = await lookupByNormalizedName(parent);
    }

    const code = await nextFreeCode();
    const fullName = `${p.name} - ${child}`;
    await query(
      `INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance, is_active, parent_code)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [code, fullName, p.type || "asset", p.normal_balance || (p.type === "asset" ? "debit" : "credit"), p.account_code]
    );

    const check = await lookupByNormalizedName(fullName);
    return check?.account_code || code;
  }

  // 3) Heuristic: infer type when unknown (keeps UX smooth)
  const lower = nameCanon.toLowerCase();
  let type =
    hint.type ||
    (lower.includes("sale") ? "income" :
     lower.includes("purchase") ? "expense" :
     (lower.includes("bank") || lower.includes("cash")) ? "asset" :
     (lower.includes("debtor") || lower.includes("receivable")) ? "asset" :
     (lower.includes("creditor") || lower.includes("payable")) ? "liability" :
     "expense");

  // Respect hint.debit for normal balance when provided
  let normal =
    (type === "income" || type === "liability" || type === "equity") ? "credit" : "debit";
  if (typeof hint.debit === "boolean") normal = hint.debit ? "debit" : "credit";

  const code = await nextFreeCode();
  await query(
    `INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance, is_active)
     VALUES ($1,$2,$3,$4,1)`,
    [code, nameCanon, type, normal]
  );
  const check = await lookupByNormalizedName(nameCanon);
  return check?.account_code || code;
}

/* ----------------- canonicalization sweep (legacy data) ----------------- */

/**
 * Normalize existing names in ledger_entries to their canonical form.
 * - Safe mappings only (Bank/Cash/GST variants; AR/AP label normalization).
 * - Bare party → AR/AP is applied only if a matching sub-ledger already exists.
 */
export async function canonicalizeExistingData() {
  // If ledger_entries table doesn't exist yet, skip quietly
  try {
    const info = await query("SELECT name FROM pragma_table_info('ledger_entries')");
    const cols = info.rows || info;
    if (!Array.isArray(cols) || cols.length === 0) return;
  } catch {
    return;
  }

  // Pull distinct ledger strings from entries
  const ledgers = await query(`
    SELECT name FROM (
      SELECT DISTINCT debit_account AS name FROM ledger_entries
      UNION
      SELECT DISTINCT credit_account FROM ledger_entries
    ) a
    WHERE name IS NOT NULL AND TRIM(name) <> ''
    ORDER BY name
  `);

  for (const r of ledgers.rows || []) {
    const oldName = r.name;
    const newName = await resolveCanonicalName(oldName);
    if (!newName || namesEqual(oldName, newName)) continue;

    // Ensure the canonical ledger exists in CoA
    await ensureLedgerExists(newName);

    // Update entries
    await query(
      "UPDATE ledger_entries SET debit_account = $1 WHERE debit_account = $2",
      [newName, oldName]
    );
    await query(
      "UPDATE ledger_entries SET credit_account = $1 WHERE credit_account = $2",
      [newName, oldName]
    );

    // Optionally mark the old ledger inactive in CoA if present
    await query(
      "UPDATE chart_of_accounts SET is_active = 0 WHERE LOWER(name) = LOWER($1)",
      [oldName]
    );
  }
}
