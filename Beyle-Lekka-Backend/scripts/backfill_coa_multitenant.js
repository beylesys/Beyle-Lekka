// scripts/backfill_coa_multitenant.js
import { query } from "../services/db.js";

/**
 * Creates per-tenant COA rows for every account that appears in ledger_entries,
 * if a tenant-scoped COA row doesn't already exist.
 * Uses simple heuristics to fill type/normal_balance if those columns exist.
 */
function guessType(name) {
  const n = String(name || "").toLowerCase();
  if (/income|revenue|sales/.test(n)) return "income";
  if (/expense|cost|electric|fuel|rent|office|advert|travel|wage|salary/.test(n)) return "expense";
  if (/cash|bank|asset|inventory|stock|receivable|debtors?/.test(n)) return "asset";
  if (/liabilit|payable|creditors?|loan|overdraft|tax\s*payable/.test(n)) return "liability";
  return null;
}
function guessNB(type, name) {
  if (type === "income" || /income|revenue|sales/i.test(name)) return "credit";
  if (type === "expense" || /expense|cost/i.test(name))       return "debit";
  if (type === "asset" || /cash|bank/i.test(name))            return "debit";
  if (type === "liability")                                   return "credit";
  return null;
}

async function hasCol(table, col) {
  const { rows } = await query(`SELECT name FROM pragma_table_info($1)`, [table]);
  return rows.some(r => String(r.name).toLowerCase() === col.toLowerCase());
}

async function main() {
  // sanity: session_id must exist on coa
  const { rows: cols } = await query(`SELECT name FROM pragma_table_info('chart_of_accounts')`);
  if (!cols.map(r=>r.name).includes("session_id")) {
    throw new Error("chart_of_accounts.session_id is missing. Run migrations/018_coa_multitenant.sql first.");
  }

  const hasType          = await hasCol('chart_of_accounts', 'type');
  const hasNormalBalance = await hasCol('chart_of_accounts', 'normal_balance');
  const hasAccountCode   = await hasCol('chart_of_accounts', 'account_code');
  const hasIsActive      = await hasCol('chart_of_accounts', 'is_active');

  // Distinct (tenant, account) names from both sides of ledger
  const { rows: used } = await query(`
    WITH names AS (
      SELECT session_id, debit_account  AS name FROM ledger_entries
      UNION
      SELECT session_id, credit_account AS name FROM ledger_entries
    )
    SELECT DISTINCT session_id, name FROM names WHERE name IS NOT NULL AND name <> ''
  `);

  let inserted = 0;
  for (const u of used) {
    const sid  = u.session_id;
    const name = u.name;

    // Already present for this tenant?
    const { rows: exists } = await query(
      `SELECT 1 FROM chart_of_accounts WHERE session_id = $1 AND name = $2 LIMIT 1`,
      [sid, name]
    );
    if (exists.length) continue;

    // Heuristic defaults
    const t  = hasType ? guessType(name) : null;
    const nb = hasNormalBalance ? guessNB(t, name) : null;

    const colsList = ['session_id','name'];
    const vals = [sid, name];

    if (hasAccountCode)   { colsList.push('account_code');   vals.push(null); }
    if (hasType)          { colsList.push('type');           vals.push(t); }
    if (hasNormalBalance) { colsList.push('normal_balance'); vals.push(nb); }
    if (hasIsActive)      { colsList.push('is_active');      vals.push(1); }

    const ph = vals.map((_,i)=>`$${i+1}`).join(',');
    await query(`INSERT OR IGNORE INTO chart_of_accounts (${colsList.join(',')}) VALUES (${ph})`, vals);
    inserted++;
  }

  console.log(`Backfill complete. Inserted ${inserted} tenant-scoped COA rows.`);
}

main().catch(e => { console.error(e); process.exit(1); });
