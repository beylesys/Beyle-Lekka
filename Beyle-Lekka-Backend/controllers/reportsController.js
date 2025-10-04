// controllers/reportsController.js
import { query } from "../services/db.js";

/* ------------------------ helpers ------------------------ */

function normalizeDate(input) {
  if (!input || typeof input !== "string") return new Date().toISOString().slice(0, 10);
  const s = input.slice(0, 10).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const sum    = (arr, pick) => round2(arr.reduce((s, x) => s + Number(pick ? pick(x) : x || 0), 0));
const isTiny = (n) => Math.abs(Number(n || 0)) < 0.005;

/* ------------------------ dynamic detection (cached) ------------------------ */

let _dialect = null;
async function detectDialect() {
  if (_dialect) return _dialect;
  try {
    // SQLite: PRAGMA as a SELECT works here
    await query(`SELECT name FROM pragma_table_info('ledger_entries')`);
    _dialect = "sqlite";
  } catch {
    _dialect = "pg";
  }
  return _dialect;
}

function safeIdent(t) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(t || ""))) {
    throw new Error(`Invalid identifier: ${t}`);
  }
  return t;
}

async function columnNames(table) {
  // Try Postgres first
  try {
    const r = await query(
      `SELECT lower(column_name) AS name
         FROM information_schema.columns
        WHERE lower(table_name) = lower($1)`,
      [table]
    );
    if (Array.isArray(r.rows)) return r.rows.map(x => x.name);
  } catch {}
  // Fallback: SQLite PRAGMA (identifiers cannot be bound)
  try {
    const t = safeIdent(table);
    const r2 = await query(`PRAGMA table_info(${t})`);
    if (Array.isArray(r2.rows)) {
      return r2.rows.map(x => String(x.name || x.NAME).toLowerCase());
    }
  } catch {}
  return [];
}

let _hasCoaSid = null;
async function hasCoaSessionId() {
  if (_hasCoaSid !== null) return _hasCoaSid;
  const cols = await columnNames("chart_of_accounts");
  _hasCoaSid = cols.includes("session_id");
  return _hasCoaSid;
}

// Return an expression that yields amount IN CENTS, robust to both columns and both dialects.
let _amtExpr = null;
async function amountCentsExpr(prefix = "le") {
  if (_amtExpr) return _amtExpr;
  const cols = await columnNames("ledger_entries");
  const hasCents = cols.includes("amount_cents");
  const hasUnits = cols.includes("amount");
  const d = await detectDialect();

  if (hasCents && hasUnits) {
    _amtExpr = d === "pg"
      ? `COALESCE(${prefix}.amount_cents, CAST(ROUND((${prefix}.amount)::numeric * 100) AS BIGINT))`
      : `COALESCE(${prefix}.amount_cents, CAST(ROUND(${prefix}.amount * 100) AS INTEGER))`;
  } else if (hasCents) {
    _amtExpr = `${prefix}.amount_cents`;
  } else if (hasUnits) {
    _amtExpr = d === "pg"
      ? `CAST(ROUND((${prefix}.amount)::numeric * 100) AS BIGINT)`
      : `CAST(ROUND(${prefix}.amount * 100) AS INTEGER)`;
  } else {
    _amtExpr = `0`;
  }

  return _amtExpr;
}

let _dateCTE = null;
async function getDateNormalizerCTE() {
  if (_dateCTE) return _dateCTE;
  const d = await detectDialect();
  if (d === "pg") {
    _dateCTE = `
      WITH le AS (
        SELECT * ,
          CASE
            WHEN length(transaction_date) >= 10
             AND substring(transaction_date from 3 for 1) IN ('-','/')
             AND substring(transaction_date from 6 for 1) IN ('-','/')
            THEN substring(transaction_date from 7 for 4) || '-' || substring(transaction_date from 4 for 2) || '-' || substring(transaction_date from 1 for 2)
            ELSE substring(transaction_date from 1 for 10)
          END AS txn_date
        FROM ledger_entries
        WHERE ($1 IS NULL OR session_id = $1)
      )
    `;
  } else {
    _dateCTE = `
      WITH le AS (
        SELECT * ,
          CASE
            WHEN length(transaction_date) >= 10
             AND substr(transaction_date,3,1) IN ('-','/')
             AND substr(transaction_date,6,1) IN ('-','/')
            THEN substr(transaction_date,7,4) || '-' || substr(transaction_date,4,2) || '-' || substr(transaction_date,1,2)
            ELSE substr(transaction_date,1,10)
          END AS txn_date
        FROM ledger_entries
        WHERE ($1 IS NULL OR session_id = $1)
      )
    `;
  }
  return _dateCTE;
}

/**
 * Tenant‑first join to CoA with GLOBAL fallback, without creating duplicates.
 * - If $1 is NULL: admin/all-scope → join only GLOBAL to avoid cross-tenant duplication.
 * - If $1 is NOT NULL: prefer tenant row; fallback to GLOBAL when a tenant row doesn't exist.
 */
async function coaJoinClause() {
  const hasSid = await hasCoaSessionId();
  if (hasSid) {
    return `
      LEFT JOIN chart_of_accounts coa
        ON (coa.name = a.account OR coa.account_code = a.account)
       AND (
             ( $1 IS NULL AND coa.session_id = 'GLOBAL' )
          OR ( $1 IS NOT NULL AND (
                 coa.session_id = $1
                 OR (
                      coa.session_id = 'GLOBAL'
                  AND NOT EXISTS (
                        SELECT 1
                          FROM chart_of_accounts c2
                         WHERE c2.session_id = $1
                           AND (c2.name = a.account OR c2.account_code = a.account)
                      )
                 )
             ))
       )
    `;
  }
  // Legacy (no session_id column) – simple name/code join
  return `
    LEFT JOIN chart_of_accounts coa
           ON (coa.name = a.account OR coa.account_code = a.account)
  `;
}

/* ======================================================================
 * TRIAL BALANCE
 * ==================================================================== */
export async function trialBalance(req, res) {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId ?? null; // NULL -> admin ALL scope allowed (read-only)

    const asOf = normalizeDate(req.query.asOf || req.body?.asOf || req.query.to || req.body?.to);
    const DATE_NORMALIZER = await getDateNormalizerCTE();
    const AMT = await amountCentsExpr("le");

    const r = await query(
      `
      ${DATE_NORMALIZER}
      , debits AS (
        SELECT debit_account AS account, SUM(${AMT}) AS d
          FROM le
         WHERE le.txn_date <= $2
         GROUP BY debit_account
      ),
      credits AS (
        SELECT credit_account AS account, SUM(${AMT}) AS c
          FROM le
         WHERE le.txn_date <= $2
         GROUP BY credit_account
      ),
      all_accts AS (
        SELECT account FROM debits
        UNION
        SELECT account FROM credits
      )
      SELECT a.account,
             COALESCE(d.d,0) / 100.0 AS debit,
             COALESCE(c.c,0) / 100.0 AS credit,
             (COALESCE(d.d,0) - COALESCE(c.c,0)) / 100.0 AS balance
        FROM all_accts a
        LEFT JOIN debits d ON a.account = d.account
        LEFT JOIN credits c ON a.account = c.account
       ORDER BY a.account
      `,
      [sid, asOf]
    );

    const rows = (r.rows || []).map((x) => ({
      account: x.account,
      debit: round2(x.debit),
      credit: round2(x.credit),
      balance: round2(x.balance),
    }));

    const totals = {
      debit: sum(rows, (x) => x.debit),
      credit: sum(rows, (x) => x.credit),
    };
    const diff = round2(totals.debit - totals.credit);
    const tallyOk = isTiny(diff);

    return res.json({ ok: true, asOf, rows, totals, diff, tallyOk });
  } catch (err) {
    console.error("TB error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/* ======================================================================
 * PROFIT & LOSS
 * ==================================================================== */
export async function profitAndLoss(req, res) {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId ?? null;

    const from = normalizeDate(req.query.from || req.body?.from || "1900-01-01");
    const to   = normalizeDate(req.query.to   || req.body?.to);

    const DATE_NORMALIZER = await getDateNormalizerCTE();
    const AMT      = await amountCentsExpr("le");
    const COA_JOIN = await coaJoinClause();

    const per = await query(
      `
      ${DATE_NORMALIZER}
      , moves AS (
        SELECT debit_account  AS account, ${AMT} AS amt,  1 AS side
          FROM le
         WHERE le.txn_date BETWEEN $2 AND $3
        UNION ALL
        SELECT credit_account AS account, ${AMT} AS amt, -1 AS side
          FROM le
         WHERE le.txn_date BETWEEN $2 AND $3
      ),
      agg AS (
        SELECT account, SUM(amt * side) AS net_cents
          FROM moves
         GROUP BY account
      ),
      mapped AS (
        SELECT a.account,
               LOWER(COALESCE(coa.type, ''))           AS type,
               LOWER(COALESCE(coa.normal_balance, '')) AS normal_balance,
               a.net_cents
          FROM agg a
          ${COA_JOIN}
      )
      SELECT account, type,
             CASE
               WHEN type = 'income'  THEN (-net_cents) / 100.0
               WHEN type = 'expense' THEN ( net_cents) / 100.0
               ELSE 0.0
             END AS amount
        FROM mapped
       WHERE type IN ('income','expense')
       ORDER BY type, account
      `,
      [sid, from, to]
    );

    const rows = per.rows || [];
    const income   = rows.filter(r => r.type === "income"  && !isTiny(r.amount))
                         .map(r => ({ account: r.account, amount: round2(r.amount) }));
    const expenses = rows.filter(r => r.type === "expense" && !isTiny(r.amount))
                         .map(r => ({ account: r.account, amount: round2(r.amount) }));

    const totals = {
      income:   sum(income,   r => r.amount),
      expenses: sum(expenses, r => r.amount),
    };
    totals.net = round2(totals.income - totals.expenses);

    // Diagnostics: moved-but-untyped ledgers in this period
    const diag = await query(
      `
      ${DATE_NORMALIZER}
      , moves AS (
        SELECT debit_account  AS account, ${AMT} AS amt,  1 AS side
          FROM le
         WHERE le.txn_date BETWEEN $2 AND $3
        UNION ALL
        SELECT credit_account AS account, ${AMT} AS amt, -1 AS side
          FROM le
         WHERE le.txn_date BETWEEN $2 AND $3
      ),
      agg AS ( SELECT account, SUM(amt * side) AS net_cents FROM moves GROUP BY account ),
      mapped AS (
        SELECT a.account, LOWER(COALESCE(coa.type, '')) AS type, a.net_cents
          FROM agg a
          ${COA_JOIN}
      )
      SELECT account, (net_cents / 100.0) AS amount
        FROM mapped
       WHERE (type NOT IN ('income','expense') OR type = '')
         AND ABS(net_cents) > 0
       ORDER BY account
      `,
      [sid, from, to]
    );

    const diagnostics = { untyped: (diag.rows || []).map(r => ({ account: r.account, amount: round2(r.amount) })) };

    return res.json({ ok: true, from, to, income, expenses, totals, diagnostics });
  } catch (err) {
    console.error("P&L error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/* ======================================================================
 * BALANCE SHEET — guaranteed to tally
 * ==================================================================== */
export async function balanceSheet(req, res) {
  try {
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId ?? null;

    const asOf = normalizeDate(req.query.to || req.body?.to || req.query.asOf || req.body?.asOf);

    const DATE_NORMALIZER = await getDateNormalizerCTE();
    const AMT      = await amountCentsExpr("le");
    const COA_JOIN = await coaJoinClause();

    const per = await query(
      `
      ${DATE_NORMALIZER}
      , moves AS (
        SELECT debit_account  AS account, ${AMT} AS amt,  1 AS side
          FROM le
         WHERE le.txn_date <= $2
        UNION ALL
        SELECT credit_account AS account, ${AMT} AS amt, -1 AS side
          FROM le
         WHERE le.txn_date <= $2
      ),
      agg AS (
        SELECT account, SUM(amt * side) AS net_cents
          FROM moves
         GROUP BY account
      ),
      mapped AS (
        SELECT a.account,
               LOWER(COALESCE(coa.type, ''))           AS type,
               LOWER(COALESCE(coa.normal_balance, '')) AS normal_balance,
               a.net_cents
          FROM agg a
          ${COA_JOIN}
      ),
      per_account AS (
        SELECT account,
               type,
               CASE
                 WHEN type = 'asset'                 THEN  net_cents
                 WHEN type IN ('liability','equity') THEN -net_cents
                 ELSE 0
               END / 100.0 AS amount
          FROM mapped
         WHERE type IN ('asset','liability','equity')
      ),
      current_earnings AS (
        SELECT SUM(
                 CASE
                   WHEN type IN ('asset','liability','equity') THEN 0
                   ELSE -net_cents
                 END
               ) / 100.0 AS amount
          FROM mapped
      )
      SELECT account, type, amount FROM per_account
      UNION ALL
      SELECT 'Current Earnings' AS account, 'equity' AS type, amount FROM current_earnings
      ORDER BY type, account
      `,
      [sid, asOf]
    );

    const rows = per.rows || [];

    const assetsArr = rows
      .filter(r => r.type === "asset" && !isTiny(r.amount))
      .map(r => ({ account: r.account, amount: round2(r.amount) }));

    const liabEqArr = rows
      .filter(r => (r.type === "liability" || r.type === "equity") && !isTiny(r.amount))
      .map(r => ({ account: r.account, amount: round2(r.amount) }));

    const totals = {
      assets:      sum(assetsArr,   r => r.amount),
      liab_equity: sum(liabEqArr,   r => r.amount),
    };

    const diff = round2(totals.assets - totals.liab_equity);
    const tallyOk = isTiny(diff);

    // Diagnostics: non-typed accounts that still carry balances as of date
    const diag = await query(
      `
      ${DATE_NORMALIZER}
      , moves AS (
        SELECT debit_account  AS account, ${AMT} AS amt,  1 AS side
          FROM le
         WHERE le.txn_date <= $2
        UNION ALL
        SELECT credit_account AS account, ${AMT} AS amt, -1 AS side
          FROM le
         WHERE le.txn_date <= $2
      ),
      agg AS ( SELECT account, SUM(amt * side) AS net_cents FROM moves GROUP BY account ),
      mapped AS (
        SELECT a.account, LOWER(COALESCE(coa.type, '')) AS type, a.net_cents
          FROM agg a
          ${COA_JOIN}
      )
      SELECT account, (net_cents / 100.0) AS amount
        FROM mapped
       WHERE (type NOT IN ('asset','liability','equity','income','expense') OR type = '')
         AND ABS(net_cents) <> 0
       ORDER BY account
      `,
      [sid, asOf]
    );

    return res.json({
      ok: true,
      asOf,
      assets: assetsArr,
      liab_equity: liabEqArr,
      totals,
      diff,
      tallyOk,
      diagnostics: { untyped: (diag.rows || []).map(r => ({ account: r.account, amount: round2(r.amount) })) },
    });
  } catch (err) {
    console.error("BS error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
