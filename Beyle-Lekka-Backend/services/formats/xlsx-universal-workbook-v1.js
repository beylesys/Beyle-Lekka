// services/formats/xlsx-universal-workbook-v1.js
import XLSX from "xlsx";
import { pairForLedger } from "../../utils/jeCore.js";

function sheetToJson(wb, name) {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { defval: "" }) : null;
}

export default {
  id: "xlsx-universal-workbook-v1",
  displayName: "Universal Workbook (.xlsx)",
  kind: "xlsx",
  entities: ["voucher","coa","party","item","opening_balance"],
  async sniff(buf, filename) {
    const name = (filename || "").toLowerCase();
    if (!name.endsWith(".xlsx")) return { match: false, confidence: 0 };
    try {
      const wb = XLSX.read(buf.slice(0, 64 * 1024), { type: "buffer" });
      const sheets = wb.SheetNames.map(s => s.toLowerCase());
      const hasJournal = sheets.includes("journal") || sheets.includes("journallines");
      const confidence = hasJournal ? 0.95 : 0.6;
      return { match: true, confidence };
    } catch { return { match: false, confidence: 0 }; }
  },
  async parse(buffer) {
    const wb = XLSX.read(buffer, { type: "buffer" });

    // Prefer "Journal" (pairs) else "JournalLines" (lines)
    const j = sheetToJson(wb, "Journal") || sheetToJson(wb, "journal");
    const jl = sheetToJson(wb, "JournalLines") || sheetToJson(wb, "journallines");

    const pairs = [];
    const lines = [];

    if (Array.isArray(j) && j.length) {
      for (const r of j) {
        const lower = Object.fromEntries(Object.entries(r).map(([k,v]) => [String(k).trim().toLowerCase(), v]));
        const date = String(lower.date || lower.transaction_date || "").trim();
        const narr = String(lower.narration || lower.description || "").trim();
        const debit = String(lower.debit_account || "").trim();
        const credit = String(lower.credit_account || "").trim();
        const amount = Number.parseFloat(String(lower.amount ?? lower.value ?? "0").replace(/[^\d.-]/g, ""));
        if (debit && credit && Number.isFinite(amount) && amount > 0) {
          pairs.push({ debit_account: debit, credit_account: credit, amount, transaction_date: date, narration: narr });
        }
      }
    }

    if (Array.isArray(jl) && jl.length) {
      for (const r of jl) {
        const lower = Object.fromEntries(Object.entries(r).map(([k,v]) => [String(k).trim().toLowerCase(), v]));
        const date = String(lower.date || lower.transaction_date || "").trim();
        const narr = String(lower.narration || lower.description || "").trim();
        const account = String(lower.account || lower.ledger || "").trim();
        const debit = Number.parseFloat(String(lower.debit ?? "0").replace(/[^\d.-]/g, "")) || 0;
        const credit = Number.parseFloat(String(lower.credit ?? "0").replace(/[^\d.-]/g, "")) || 0;
        if (account && (debit > 0 || credit > 0)) {
          lines.push({ account, date, narration: narr, debit, credit });
        }
      }
    }

    // If only lines are provided, pair them
    let outPairs = pairs;
    if (outPairs.length === 0 && lines.length > 0) {
      const pf = pairForLedger(lines, { allowFutureDates: true });
      outPairs = Array.isArray(pf) ? pf : [];
    }

    return { lines, pairs: outPairs, meta: { journalPairs: outPairs.length, journalLines: lines.length } };
  },

  // Export: write an .xlsx with a "Journal" sheet (pairs)
  async export(db, sessionId, { from, to }) {
    const { rows } = await db.query(
      `SELECT transaction_date AS date, narration,
              debit_account AS debit_account, credit_account AS credit_account,
              (amount_cents/100.0) AS amount
         FROM ledger_entries
        WHERE session_id = $1 AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date, id`, [sessionId, from, to]);

    const ws = XLSX.utils.json_to_sheet(rows || []);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Journal");
    const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    return { files: [{ name: "Books.xlsx", content: out }] };
  },

  template() {
    const wb = XLSX.utils.book_new();
    const pairs = [{ date: "2025-04-01", debit_account: "Sales", credit_account: "Cash", amount: 1499.00, narration: "April sale" }];
    const ws = XLSX.utils.json_to_sheet(pairs);
    XLSX.utils.book_append_sheet(wb, ws, "Journal");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }
};
