// controllers/updateLedgerEntry.js
import { query } from "../services/db.js";

/**
 * POST /api/ledger/update
 * Body: { id, transaction_date, debit_account, credit_account, amount, narration }
 * - amount is in ₹ (units); we store paise in amount_cents.
 */
export const updateLedgerEntry = async (req, res) => {
  try {
    const {
      id,
      transaction_date,
      debit_account,
      credit_account,
      amount,
      narration,
    } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "id is required" });

    // Basic validation (DB also enforces date via trigger)
    const date = String(transaction_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ ok: false, error: "transaction_date must be YYYY-MM-DD" });
    }

    const debit = String(debit_account || "").trim();
    const credit = String(credit_account || "").trim();
    if (!debit || !credit) {
      return res
        .status(400)
        .json({ ok: false, error: "debit_account and credit_account are required" });
    }
    if (debit.toLowerCase() === credit.toLowerCase()) {
      return res
        .status(400)
        .json({ ok: false, error: "debit_account and credit_account cannot be the same" });
    }

    const cleaned = Number.parseFloat(String(amount).replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(cleaned) || cleaned <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "amount must be a positive number" });
    }
    const amount_cents = Math.round(cleaned * 100);

    const { changes } = await query(
      `UPDATE ledger_entries
         SET transaction_date = ?, debit_account = ?, credit_account = ?,
             amount_cents = ?, narration = ?
       WHERE id = ?`,
      [date, debit, credit, amount_cents, narration ?? "", id]
    );

    if (!changes) {
      return res.status(404).json({ ok: false, error: "Ledger entry not found" });
    }
    return res.status(200).json({ ok: true, updated: changes });
  } catch (err) {
    console.error("updateLedgerEntry error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Failed to update ledger entry" });
  }
};
