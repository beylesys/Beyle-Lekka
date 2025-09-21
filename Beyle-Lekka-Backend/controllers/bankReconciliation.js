// controllers/bankReconciliation.js
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import { query } from "../services/db.js";
import { rankCandidates } from "../utils/reco/matcher.js";

const UPLOAD_DIR = path.resolve("./uploads/bank");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"))
});

export const uploadCSV = multer({ storage });

export async function importBankCSV(req, res) {
  try {
    const { bankAccountId } = req.body || {};
    if (!bankAccountId) return res.status(400).json({ ok:false, error:"bankAccountId is required" });

    const file = req.file;
    if (!file) return res.status(400).json({ ok:false, error:"No file uploaded" });

    const csv = fs.readFileSync(file.path, "utf8");
    const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

    let count = 0;
    for (const r of rows) {
      // Expected columns: Date, Narration, Amount (credit positive, debit negative) or separate columns
      const date = r.Date || r.date || r["Value Date"] || r["value_date"];
      const narration = r.Narration || r.narration || "";
      let amt = null;
      if (r.Amount) amt = Number(r.Amount);
      else if (r.Credit && r.Debit) amt = Number(r.Credit) - Number(r.Debit);
      else if (r.credit || r.debit) amt = Number(r.credit) - Number(r.debit);
      else if (r.amount) amt = Number(r.amount);
      const amount_cents = Math.round((amt || 0) * 100);

      const id = crypto.randomUUID();
      await query(
        `INSERT INTO bank_statement_lines (id, bank_account_id, value_date, narration, amount_cents, imported_file_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, bankAccountId, String(date).slice(0,10), narration, amount_cents, file.filename]
      );
      count++;
    }

    return res.json({ ok:true, imported: count });
  } catch (err) {
    console.error("importBankCSV error", err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}

export async function suggestions(req, res) {
  try {
    const { bankAccountId, dateFrom, dateTo } = req.query;
    if (!bankAccountId) return res.status(400).json({ ok:false, error:"bankAccountId is required" });

    const b = await query(
      `SELECT * FROM bank_statement_lines
       WHERE bank_account_id=$1 AND status='unmatched'
         AND (value_date BETWEEN COALESCE($2,'1900-01-01') AND COALESCE($3,'2999-12-31'))`,
      [bankAccountId, dateFrom || null, dateTo || null]
    );

    const le = await query(
      `SELECT id, transaction_date, narration, debit_account, credit_account, amount_cents
         FROM ledger_entries
         WHERE transaction_date BETWEEN COALESCE($1,'1900-01-01') AND COALESCE($2,'2999-12-31')`,
      [dateFrom || null, dateTo || null]
    );

    const out = b.rows.map((bl) => {
      const ranked = rankCandidates(bl, le.rows, 5).slice(0, 3);
      return { bankLineId: bl.id, candidates: ranked };
    });

    return res.json({ ok:true, suggestions: out });
  } catch (err) {
    console.error("suggestions error", err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}

export async function confirmMatch(req, res) {
  try {
    const { bankLineId, ledgerEntryId } = req.body || {};
    if (!bankLineId || !ledgerEntryId) return res.status(400).json({ ok:false, error:"bankLineId and ledgerEntryId are required" });

    await query(
      `UPDATE bank_statement_lines
         SET matched_ledger_id=$1, status='matched'
       WHERE id=$2`,
      [ledgerEntryId, bankLineId]
    );

    return res.json({ ok:true });
  } catch (err) {
    console.error("confirmMatch error", err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
