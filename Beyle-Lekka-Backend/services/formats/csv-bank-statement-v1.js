// services/formats/csv-bank-statement-v1.js
import { parse as parseCSV } from "csv-parse/sync";

export default {
  id: "csv-bank-statement-v1",
  displayName: "Bank Statement (CSV)",
  kind: "csv",
  entities: ["bank_txn"],
  async sniff(buf, filename) {
    const name = (filename || "").toLowerCase();
    if (!name.endsWith(".csv")) return { match: false, confidence: 0 };
    try {
      const rows = parseCSV(buf.slice(0, 256 * 1024), { columns: true, skip_empty_lines: true });
      if (rows?.length) {
        const headers = Object.keys(rows[0]).map(h => h.trim().toLowerCase());
        const looksLike = headers.includes("date") && headers.some(h => /narration|description/.test(h)) && headers.some(h => /amount|credit|debit/.test(h));
        return { match: looksLike, confidence: looksLike ? 0.8 : 0 };
      }
    } catch { /* ignore */ }
    return { match: false, confidence: 0 };
  },
  async parse(buffer) {
    const rows = parseCSV(buffer, { columns: true, skip_empty_lines: true });
    // Normalize to { date,narration,ref,amount_cents }
    const txns = [];
    for (const r of rows) {
      const lower = Object.fromEntries(Object.entries(r).map(([k,v]) => [k.trim().toLowerCase(), v]));
      const date = String(lower.date || "").trim();
      const narration = String(lower.narration || lower.description || "").trim();
      const ref = String(lower.ref || lower.reference || "").trim();
      let amt = 0;
      if (lower.amount != null) {
        amt = Number.parseFloat(String(lower.amount).replace(/[^\d.-]/g,"")) || 0;
      } else {
        const cr = Number.parseFloat(String(lower.credit ?? "0").replace(/[^\d.-]/g,"")) || 0;
        const dr = Number.parseFloat(String(lower.debit ?? "0").replace(/[^\d.-]/g,"")) || 0;
        amt = cr - dr;
      }
      txns.push({ date, narration, ref, amount_cents: Math.round(amt*100) });
    }
    return { bank_txns: txns, meta: { rows: txns.length } };
  },
  async export() { return { files: [] }; }, // not needed for now
  template() {
    const header = "date,narration,ref,amount\n";
    const example = "2025-04-01,UPI/1234/Acme Store/9876543210,TXN001,-299.00\n";
    return Buffer.from(header + example, "utf8");
  },
};
