// utils/saveJournalEntry.js
import { query } from "../services/db.js";
import { randomUUID } from "crypto";

/**
 * Save confirmed journal entries to ledger_entries (SQLite)
 * Expects each entry to include document_id (from validator).
 */
export const saveJournalEntry = async (journalEntries, sessionId, prompt) => {
  try {
    if (!Array.isArray(journalEntries) || journalEntries.length === 0) {
      return { status: "error", message: "Journal entry array is missing or empty." };
    }

    const insertSql = `
      INSERT OR IGNORE INTO ledger_entries
        (id, session_id, debit_account, credit_account, amount, narration, transaction_date, document_id, created_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, datetime('now'))
    `;

    let insertCount = 0;
    for (const row of journalEntries) {
      const id = randomUUID();
      const {
        debit_account,
        credit_account,
        amount,
        narration = null,
        transaction_date,
        currency,             // not stored yet; add a column later if needed
        document_id
      } = row;

      await query(insertSql, [
        id,
        sessionId,
        debit_account,
        credit_account,
        amount,            // already 2dp
        narration,
        transaction_date,
        document_id || prompt // fallback
      ]);

      insertCount++;
    }

    return { status: "success", message: `${insertCount} entries saved to ledger.` };
  } catch (error) {
    console.error("❌ FULL LEDGER INSERT ERROR:", error);
    return { status: "error", message: "Failed to save entries", error: error.message };
  }
};
