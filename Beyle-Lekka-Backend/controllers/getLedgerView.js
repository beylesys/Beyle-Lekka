// controllers/getLedgerView.js
import { query } from "../services/db.js";

/**
 * GET /api/getLedgerView
 * - Scopes by tenant if req.sessionId is a concrete value.
 * - If req.sessionId === null (admin "ALL" scope), returns across all tenants.
 *   (The middleware should only allow ALL for admin/dev.)
 */
export const getLedgerView = async (req, res) => {
  try {
    // NOTE:
    //  - req.sessionId === null  -> admin "ALL" scope (allowed by middleware)
    //  - req.sessionId is string -> normal single-tenant scope
    //  - undefined               -> middleware misconfigured (treat as error)
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ ok: false, error: "Tenant middleware not initialized." });
    }

    const sid = req.sessionId ?? null; // null means "ALL"

    const { rows = [] } = await query(
      `
      SELECT id,
             transaction_date,
             debit_account,
             credit_account,
             amount,
             narration
        FROM ledger_entries_view
       WHERE ($1 IS NULL OR session_id = $1)
       ORDER BY transaction_date ASC, created_at ASC
      `,
      [sid]
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
