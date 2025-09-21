// controllers/getLedgerView.js
import { query } from "../services/db.js";

export const getLedgerView = async (_req, res) => {
  try {
    const { rows = [] } = await query(
      `SELECT id, transaction_date, debit_account, credit_account, amount, narration
         FROM ledger_entries_view
         ORDER BY transaction_date ASC, created_at ASC`
    );

    const ledgerLines = rows
      .map((e) =>
        `${e.transaction_date || ""}|${e.debit_account || ""}|${e.credit_account || ""}|${e.amount ?? ""}|${e.narration || ""}`
      )
      .join("\n");

    return res.status(200).json({
      ok: true,
      entries: rows,
      ledgerView: ledgerLines,
    });
  } catch (error) {
    console.error("getLedgerView failed:", error);
    return res
      .status(500)
      .json({ ok: false, error: error?.message || "Error fetching ledger view." });
  }
};
