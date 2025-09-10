// utils/coaService.js
import { query } from "../services/db.js";

export async function ensureLedgerExists(nameOrCode, hint = {}) {
  const name = String(nameOrCode || "").trim();
  if (!name) return;

  try {
    const { rows } = await query(
      "SELECT account_code FROM chart_of_accounts WHERE (account_code = $1 OR name = $1) AND is_active = 1 LIMIT 1",
      [name]
    );
    if (rows.length) return rows[0].account_code;
  } catch {
    // table may not exist yet; skip
    return;
  }

  const { type, normal_balance } = guessTypeAndNB(name, hint);
  await query(
    `INSERT OR IGNORE INTO chart_of_accounts (account_code, name, type, normal_balance, is_active)
     VALUES ($1, $1, $2, $3, 1)`,
    [name, type, normal_balance]
  );

  return name;
}

function guessTypeAndNB(name, hint) {
  const debitSide = hint.debit === true;
  const nm = name.toLowerCase();

  if (nm.includes("cash") || nm.includes("bank"))                  return { type: "Asset",     normal_balance: "debit"  };
  if (nm.includes("receivable") || nm.includes("debtor"))          return { type: "Asset",     normal_balance: "debit"  };
  if (nm.includes("payable") || nm.includes("creditor"))           return { type: "Liability", normal_balance: "credit" };
  if (nm.includes("sales") || nm.includes("revenue") || nm.includes("income"))
                                                                  return { type: "Income",    normal_balance: "credit" };
  if (nm.includes("purchase") || nm.includes("cogs"))              return { type: "Expense",   normal_balance: "debit"  };
  if (nm.includes("gst") || nm.includes("tax") || nm.includes("duties"))
                                                                  return { type: "Liability", normal_balance: "credit" };

  return debitSide ? { type: "Expense", normal_balance: "debit" } : { type: "Income", normal_balance: "credit" };
}
