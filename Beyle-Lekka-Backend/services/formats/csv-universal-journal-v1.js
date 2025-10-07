// services/formats/csv-universal-journal-v1.js
import { parse as parseCSV } from "csv-parse/sync";
import { createObjectCsvStringifier } from "csv-writer";
import { pairForLedger } from "../../utils/jeCore.js";

export default {
  id: "csv-universal-journal-v1",
  displayName: "Universal Journal (CSV)",
  kind: "csv",
  entities: ["voucher"],
  async sniff(buf, filename) {
    const name = (filename || "").toLowerCase();
    if (name.endsWith(".csv")) {
      try {
        const rows = parseCSV(buf.slice(0, 256 * 1024), { columns: true, skip_empty_lines: true });
        if (Array.isArray(rows) && rows.length) {
          const headers = Object.keys(rows[0]).map(h => h.trim().toLowerCase());
          const hasPair = headers.includes("debit_account") && headers.includes("credit_account") && (headers.includes("amount") || headers.includes("value"));
          const hasLines = headers.includes("account") && (headers.includes("debit") || headers.includes("credit"));
          const confidence = hasPair ? 0.95 : hasLines ? 0.80 : 0.0;
          return { match: confidence > 0, confidence };
        }
      } catch {/* ignore */}
    }
    return { match: false, confidence: 0 };
  },
  async parse(buffer) {
    const rows = parseCSV(buffer, { columns: true, skip_empty_lines: true });
    const normLines = [];
    const pairs = [];

    for (const r of rows) {
      const k = (s) => (s == null ? "" : String(s).trim());
      const lower = Object.fromEntries(Object.entries(r).map(([k1,v]) => [k1.trim().toLowerCase(), v]));
      const date = k(lower.date || lower.transaction_date);
      const narr = k(lower.narration || lower.description);

      // If pair-like
      if (lower.debit_account || lower.credit_account) {
        const debit_account = k(lower.debit_account);
        const credit_account = k(lower.credit_account);
        const amount = Number.parseFloat(String(lower.amount ?? lower.value ?? "0").replace(/[^\d.-]/g, ""));
        if (debit_account && credit_account && Number.isFinite(amount) && amount > 0) {
          pairs.push({ debit_account, credit_account, amount, transaction_date: date, narration: narr });
          continue;
        }
      }

      // Else treat as line-form
      if (lower.account) {
        const account = k(lower.account);
        const debit = Number.parseFloat(String(lower.debit ?? "0").replace(/[^\d.-]/g, "")) || 0;
        const credit = Number.parseFloat(String(lower.credit ?? "0").replace(/[^\d.-]/g, "")) || 0;
        normLines.push({ account, date, narration: narr, debit, credit });
      }
    }

    // If only lines were provided, produce balanced pairs (best effort)
    let outPairs = pairs;
    if (outPairs.length === 0 && normLines.length > 0) {
      const pf = pairForLedger(normLines, { allowFutureDates: true });
      outPairs = Array.isArray(pf) ? pf : [];
    }

    return { lines: normLines, pairs: outPairs, meta: { rows: rows.length } };
  },

  // Exporter for the same profile (CSV rows of pairs)
  async export(db, sessionId, { from, to }) {
    const { rows } = await db.query(
      `SELECT transaction_date AS date, narration,
              debit_account AS debit, credit_account AS credit,
              (amount_cents/100.0) AS amount
         FROM ledger_entries
        WHERE session_id = $1 AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date, id`, [sessionId, from, to]);
    const csv = createObjectCsvStringifier({ header: [
      { id: "date", title: "date" },
      { id: "debit", title: "debit_account" },
      { id: "credit", title: "credit_account" },
      { id: "amount", title: "amount" },
      { id: "narration", title: "narration" },
    ]});
    const content = csv.getHeaderString() + csv.stringifyRecords(rows || []);
    return { files: [{ name: "Journal.csv", content }] };
  },

  // Downloadable template for users
  template() {
    const header = "date,debit_account,credit_account,amount,narration\n";
    const example = "2025-04-01,Sales,Cash,1499.00,April sale\n";
    return Buffer.from(header + example, "utf8");
  },
};
