#!/usr/bin/env node
import { query } from "../services/db.js";

const TARGET = process.argv[2] || process.env.DEFAULT_SESSION_ID || "S-DEV";
const tables = [
  "ledger_entries","ledger_entries_v2","chart_of_accounts","documents","files","extractions",
  "items","stock_ledger","closed_periods","bank_accounts","bank_statement_lines",
  "warehouses","coa_synonyms","series_reservations","idempotency_keys","memory_log"
];

for (const t of tables) {
  await query(`UPDATE ${t} SET session_id = $1 WHERE session_id IS NULL`, [TARGET]);
}
console.log(`Done. Backfilled NULL session_id to ${TARGET}.`);
