// controllers/reportsController.js
import { query } from "../services/db.js";

// Helpers
function toISO(d) {
  return (d || new Date().toISOString().slice(0, 10));
}

/**
 * TRIAL BALANCE
 * Response shape (matches UI):
 * { ok, asOf, rows: [{account, debit, credit, balance}] }
 */
export async function trialBalance(req, res) {
  try {
    const asOf = (req.query.asOf || req.body?.asOf || toISO()).slice(0, 10);

    const res1 = await query(
      `
      WITH debits AS (
        SELECT debit_account AS account, SUM(amount_cents) AS d
        FROM ledger_entries
        WHERE transaction_date <= $1
        GROUP BY debit_account
      ),
      credits AS (
        SELECT credit_account AS account, SUM(amount_cents) AS c
        FROM ledger_entries
        WHERE transaction_date <= $1
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
      [asOf]
    );

    return res.json({ ok: true, asOf, rows: res1.rows });
  } catch (err) {
    console.error("TB error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * PROFIT & LOSS
 * UI expects:
 * {
 *   ok, from, to,
 *   income:   [{account, amount}],
 *   expenses: [{account, amount}],
 *   totals: { income, expenses, net }
 * }
 */
export async function profitAndLoss(req, res) {
  try {
    const from = (req.query.from || req.body?.from || "1900-01-01").slice(0, 10);
    const to   = (req.query.to   || req.body?.to   || toISO()).slice(0, 10);

    // Per-account net within window, with CoA typing
    const per = await query(
      `
      WITH moves AS (
        SELECT debit_account  AS account, amount_cents AS amt,  1 AS side
          FROM ledger_entries
         WHERE transaction_date BETWEEN $1 AND $2
        UNION ALL
        SELECT credit_account AS account, amount_cents AS amt, -1 AS side
          FROM ledger_entries
         WHERE transaction_date BETWEEN $1 AND $2
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
          LEFT JOIN chart_of_accounts coa
                 ON (coa.name = a.account OR coa.account_code = a.account)
      )
      SELECT account, type,
             /* income is credit-normal → show positive by negating net;
                expense is debit-normal → show positive as-is. */
             CASE
               WHEN type = 'income'  THEN (-net_cents) / 100.0
               WHEN type = 'expense' THEN ( net_cents) / 100.0
               ELSE 0.0
             END AS amount
        FROM mapped
       WHERE type IN ('income','expense')
       ORDER BY type, account
      `,
      [from, to]
    );

    const rows = per.rows || [];

    const income   = rows.filter(r => r.type === "income"  && Math.abs(r.amount) > 1e-9)
                         .map(r => ({ account: r.account, amount: r.amount }));
    const expenses = rows.filter(r => r.type === "expense" && Math.abs(r.amount) > 1e-9)
                         .map(r => ({ account: r.account, amount: r.amount }));

    const totals = {
      income:   income.reduce((s, r) => s + (r.amount || 0), 0),
      expenses: expenses.reduce((s, r) => s + (r.amount || 0), 0),
    };
    totals.net = totals.income - totals.expenses;

    return res.json({ ok: true, from, to, income, expenses, totals });
  } catch (err) {
    console.error("P&L error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * BALANCE SHEET
 * UI expects:
 * {
 *   ok, asOf,
 *   assets:      [{account, amount}],
 *   liab_equity: [{account, amount}],
 *   totals: { assets, liab_equity }
 * }
 */
export async function balanceSheet(req, res) {
  try {
    const asOf = (req.query.asOf || req.body?.asOf || toISO()).slice(0, 10);

    const per = await query(
      `
      WITH moves AS (
        SELECT debit_account  AS account, amount_cents AS amt,  1 AS side
          FROM ledger_entries
         WHERE transaction_date <= $1
        UNION ALL
        SELECT credit_account AS account, amount_cents AS amt, -1 AS side
          FROM ledger_entries
         WHERE transaction_date <= $1
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
          LEFT JOIN chart_of_accounts coa
                 ON (coa.name = a.account OR coa.account_code = a.account)
      ),
      per_account AS (
        SELECT account,
               type,
               /* Assets debit-normal → +net; Liab/Equity credit-normal → -net */
               CASE
                 WHEN type = 'asset'                  THEN  net_cents
                 WHEN type IN ('liability','equity')  THEN -net_cents
                 ELSE 0
               END / 100.0 AS amount
          FROM mapped
         WHERE type IN ('asset','liability','equity')
      )
      SELECT account, type, amount
        FROM per_account
       WHERE ABS(amount) > 0.000001
       ORDER BY type, account
      `,
      [asOf]
    );

    const rows = per.rows || [];

    const assetsArr = rows
      .filter(r => r.type === "asset")
      .map(r => ({ account: r.account, amount: r.amount }));

    const liabEqArr = rows
      .filter(r => r.type === "liability" || r.type === "equity")
      .map(r => ({ account: r.account, amount: r.amount }));

    const totals = {
      assets:      assetsArr.reduce((s, r) => s + (r.amount || 0), 0),
      liab_equity: liabEqArr.reduce((s, r) => s + (r.amount || 0), 0),
    };

    return res.json({ ok: true, asOf, assets: assetsArr, liab_equity: liabEqArr, totals });
  } catch (err) {
    console.error("BS error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
