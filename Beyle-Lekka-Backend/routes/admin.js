import express from "express";
import adminOnly from "../middleware/adminOnly.js";
import { query } from "../services/db.js";

const router = express.Router();

router.get("/sessions", adminOnly, async (_req, res) => {
  const r = await query(`
    SELECT session_id, COUNT(*) AS ledger_rows
    FROM ledger_entries
    GROUP BY session_id
    ORDER BY ledger_rows DESC`);
  res.json({ sessions: r.rows || [] });
});

router.post("/move-session", adminOnly, async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from/to required" });

  const tables = [
    "ledger_entries", "ledger_entries_v2",
    "chart_of_accounts", "documents", "files", "extractions",
    "items", "stock_ledger", "closed_periods",
    "bank_accounts", "bank_statement_lines",
    "warehouses", "coa_synonyms",
    "series_reservations", "idempotency_keys", "memory_log"
  ];

  for (const t of tables) {
    await query(`UPDATE ${t} SET session_id = $1 WHERE session_id = $2`, [to, from]);
  }
  res.json({ ok: true, from, to });
});

export default router;
