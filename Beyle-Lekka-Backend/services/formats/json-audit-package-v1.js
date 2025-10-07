// services/formats/json-audit-package-v1.js
export default {
  id: "json-audit-package-v1",
  displayName: "Audit Package (JSON)",
  kind: "json",
  entities: ["voucher","coa","party","item"],
  async sniff(_buf, filename) {
    const name = (filename || "").toLowerCase();
    return { match: name.endsWith(".json"), confidence: name.endsWith(".json") ? 0.5 : 0 };
  },
  async parse(_buffer) {
    // For now we don't support importing arbitrary JSON; the Field Mapper would handle that path.
    return { lines: [], pairs: [], meta: { note: "json import not supported yet" } };
  },
  async export(db, sessionId, { from, to }) {
    const { rows: entries } = await db.query(
      `SELECT id, session_id, debit_account, credit_account, amount_cents,
              narration, transaction_date, created_at, uniq_hash
         FROM ledger_entries
        WHERE session_id = $1 AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date, id`, [sessionId, from, to]);
    const payload = { profile: "json-audit-package-v1", session_id: sessionId, from, to, ledger_entries: entries || [] };
    return { files: [{ name: "audit.json", content: JSON.stringify(payload, null, 2) }] };
  },
  template(){ return Buffer.from('{\n  "profile":"json-audit-package-v1"\n}\n','utf8'); }
};
