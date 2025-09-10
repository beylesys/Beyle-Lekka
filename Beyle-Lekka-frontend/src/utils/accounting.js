// Basic helpers to compute reports from your ledger 'entries' array:
// each row: { transaction_date, debit_account, credit_account, amount, narration }

const norm = (s) => (s || "").trim();

// ---- TRIAL BALANCE ----
// returns [{ account, debit, credit }]
export function computeTrialBalance(entries = []) {
  const totals = new Map();

  const add = (acc, side, amt) => {
    const key = norm(acc) || "(Unspecified)";
    if (!totals.has(key)) totals.set(key, { account: key, debit: 0, credit: 0 });
    totals.get(key)[side] += Number(amt || 0);
  };

  entries.forEach((r) => {
    if (r.debit_account) add(r.debit_account, "debit", r.amount);
    if (r.credit_account) add(r.credit_account, "credit", r.amount);
  });

  return Array.from(totals.values()).sort((a, b) => a.account.localeCompare(b.account));
}

// ---- LIGHTWEIGHT ACCOUNT CLASSIFICATION ----
// You can refine these rules or replace with a Chart of Accounts later.
export const defaultAccountTypes = {
  assets: [
    "cash", "bank", "petty cash", "inventory", "debtors", "accounts receivable",
    "input gst", "input sgst", "input cgst", "fixed assets", "laptop", "printer"
  ],
  liabilities: [
    "creditors", "accounts payable", "duties & taxes", "output gst", "output sgst", "output cgst", "loans", "overdraft"
  ],
  equity: [
    "capital", "retained earnings", "owner's equity", "share capital"
  ],
  income: [
    "sales", "revenue", "interest income", "other income"
  ],
  expenses: [
    "purchase", "purchases", "rent", "salary", "wages", "electricity", "internet",
    "office repairs", "repairs & maintenance", "printing & stationery", "travel",
    "bank charges", "depreciation"
  ],
};

// classify by name using the map above
export function classifyAccount(name, accountTypes = defaultAccountTypes) {
  const n = norm(name).toLowerCase();

  const matches = (list) => list.some((kw) => n.includes(kw));
  if (matches(accountTypes.income)) return "income";
  if (matches(accountTypes.expenses)) return "expenses";
  if (matches(accountTypes.assets)) return "assets";
  if (matches(accountTypes.liabilities)) return "liabilities";
  if (matches(accountTypes.equity)) return "equity";
  return "uncategorized";
}

// ---- P&L ----
// returns { income:[{account, amount}], expenses:[{account, amount}], totalIncome, totalExpenses, netProfit }
export function computePL(entries = [], accountTypes = defaultAccountTypes) {
  const tb = computeTrialBalance(entries);
  const income = [];
  const expenses = [];

  tb.forEach((row) => {
    const cls = classifyAccount(row.account, accountTypes);
    const bal = Math.abs(Number(row.debit) - Number(row.credit)); // account balance
    if (!bal) return;

    if (cls === "income") income.push({ account: row.account, amount: bal });
    else if (cls === "expenses") expenses.push({ account: row.account, amount: bal });
  });

  const totalIncome = income.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  const netProfit = totalIncome - totalExpenses;

  return { income, expenses, totalIncome, totalExpenses, netProfit };
}

// ---- BALANCE SHEET ----
// returns { assets:[{account, amount}], liabilities:[{account, amount}], equity:[{account, amount}], totals }
export function computeBalanceSheet(entries = [], accountTypes = defaultAccountTypes, pl = null) {
  const tb = computeTrialBalance(entries);
  const assets = [];
  const liabilities = [];
  const equity = [];

  tb.forEach((row) => {
    const cls = classifyAccount(row.account, accountTypes);
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const balance = debit - credit; // positive => Dr, negative => Cr

    // Typical conventions:
    // Assets (debit balances), Liabilities/Equity (credit balances)
    if (cls === "assets" && balance !== 0) {
      assets.push({ account: row.account, amount: Math.abs(balance) });
    } else if ((cls === "liabilities" || cls === "equity") && balance !== 0) {
      liabilities.push({ account: row.account, amount: Math.abs(balance) });
      // You may split equity separately if you prefer
    }
  });

  // Pull net profit from P&L and add to equity section
  const profitPack = pl || computePL(entries, accountTypes);
  if (profitPack.netProfit !== 0) {
    equity.push({
      account: profitPack.netProfit >= 0 ? "Current Year Profit" : "Current Year Loss",
      amount: Math.abs(profitPack.netProfit),
    });
  }

  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);

  return {
    assets,
    liabilities,
    equity,
    totals: {
      assets: totalAssets,
      liabilitiesAndEquity: totalLiabilities + totalEquity,
    },
  };
}
