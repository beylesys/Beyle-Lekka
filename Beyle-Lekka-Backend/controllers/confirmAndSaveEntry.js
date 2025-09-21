// controllers/confirmAndSaveEntry.js (drop-in replacement)
// Atomic posting; supports cents-based storage if present; robust PRAGMA detection.

import { query, withTx } from "../services/db.js";
import { randomUUID } from "crypto";

import { validateAndPreparePreview, pairForLedger } from "../utils/jeCore.js";
import { ensureLedgerExists } from "../utils/coaService.js";

import { generateInvoiceDoc } from "../utils/docGenerators/invoice.js";
import { generateReceiptDoc } from "../utils/docGenerators/receipt.js";
import { generatePaymentVoucherDoc } from "../utils/docGenerators/paymentVoucher.js";

import { getSnapshot } from "../utils/preview/snapshotStore.js";
import { finalizeReservation } from "../services/series.js";

// ---------- helpers ----------
const toCents = (v) => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.round(v * 100);
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const appendDocRefToNarration = (lines, docType, number) => {
  if (!Array.isArray(lines) || !docType || !number) return lines || [];
  const tag = `[${String(docType).toUpperCase()} #${number}]`;
  return lines.map(l => ({ ...l, narration: l.narration ? `${l.narration} ${tag}` : tag }));
};

async function ensureAccountsExistForJournal(journal) {
  const seen = new Set();
  for (const e of journal || []) {
    if (e && typeof e.account === "string") {
      const name = e.account.trim();
      if (name && !seen.has(name)) {
        await ensureLedgerExists(name);
        seen.add(name);
      }
    }
  }
}

let _columnsCache = null;
async function detectColumns() {
  if (_columnsCache) return _columnsCache;

  // Use SELECT on pragma_table_info to guarantee rows with better-sqlite3
  const led = await query(`SELECT name FROM pragma_table_info('ledger_entries')`);
  const doc = await query(`SELECT name FROM pragma_table_info('documents')`);
  const ledNames = (led.rows || []).map(r => r.name || r.NAME);
  const docNames = (doc.rows || []).map(r => r.name || r.NAME);

  const hasAmountCents = ledNames.includes("amount_cents");
  const hasAmount = ledNames.includes("amount");
  const hasGrossAmountCents = docNames.includes("gross_amount_cents");
  const hasGrossAmount = docNames.includes("gross_amount");

  _columnsCache = { hasAmountCents, hasAmount, hasGrossAmountCents, hasGrossAmount };
  return _columnsCache;
}

// ---------- main ----------
export const confirmAndSaveEntry = async (req, res) => {
  try {
    const { previewId, hash, idempotencyKey, sessionId = "default-session" } = req.body || {};
    const cols = await detectColumns();

    // Prefer snapshot flow (preview -> confirm)
    if (previewId && hash) {
      const snap = await getSnapshot(previewId);
      if (!snap || snap.status !== "ACTIVE") {
        return res.status(410).json({ success: false, error: "Preview expired or already used" });
      }
      if (String(snap.hash) !== String(hash)) {
        return res.status(409).json({ success: false, error: "Preview content changed; re-preview required" });
      }

      const payload = snap.payload || {};
      const sDocType = payload.docType || "journal";
      const sDocModel = payload.docModel || {};
      const sJournal = Array.isArray(payload.journal) ? payload.journal : [];

      // Ensure ledgers exist for accounts
      await ensureAccountsExistForJournal(sJournal);

      // Pair exactly as preview (jeCore pairs via cents internally, outputs amount in units)
      const withRef = appendDocRefToNarration(sJournal, sDocType, sDocModel.number);
      const pairs = pairForLedger(withRef);
      if (!pairs.length) {
        return res.status(422).json({ success: false, error: "Snapshot journal unbalanced or empty." });
      }

      let insertedDocId = null;

      await withTx(async () => {
        // 1) Idempotency (safe retry)
        if (idempotencyKey) {
          await query("INSERT OR IGNORE INTO idempotency_keys (key) VALUES ($1)", [idempotencyKey]);
        }

        // 2) Insert the document row (if any)
        if (sDocType && sDocType !== "journal" && (sDocModel.number || sDocModel.date)) {
          insertedDocId = randomUUID();
          const dateISO = (sDocModel.date || new Date().toISOString().slice(0,10)).slice(0,10);
          // Try generic party mapping (supports {party} or known keys from different flows)
          const party =
            sDocModel.party || sDocModel.customer || sDocModel.buyer || sDocModel.buyerName || sDocModel.vendor || null;

          const grossUnits = sDocModel.total != null ? Number(sDocModel.total) : null;
          const grossCents = grossUnits != null ? toCents(grossUnits) : null;

          if (cols.hasGrossAmountCents) {
            await query(
              `INSERT INTO documents (id, doc_type, number, date, party_name, gross_amount_cents, status, file_url, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,'FINALIZED',NULL,$7)`,
              [insertedDocId, sDocType, sDocModel.number || null, dateISO, party, grossCents, req.body?.userId || null]
            );
          } else if (cols.hasGrossAmount) {
            await query(
              `INSERT INTO documents (id, doc_type, number, date, party_name, gross_amount, status, file_url, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,'FINALIZED',NULL,$7)`,
              [insertedDocId, sDocType, sDocModel.number || null, dateISO, party, grossUnits || null, req.body?.userId || null]
            );
          } else {
            // documents table without any gross amount column
            await query(
              `INSERT INTO documents (id, doc_type, number, date, party_name, status, file_url, created_by)
               VALUES ($1,$2,$3,$4,$5,'FINALIZED',NULL,$6)`,
              [insertedDocId, sDocType, sDocModel.number || null, dateISO, party, req.body?.userId || null]
            );
          }
        }

        // 3) Insert ledger entries (uses cents if column exists); link to doc if we created one.
        const insertSqlCents = `
          INSERT INTO ledger_entries
            (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, document_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `;
        const insertSqlUnits = `
          INSERT INTO ledger_entries
            (id, session_id, debit_account, credit_account, amount, narration, transaction_date, document_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `;

        for (const p of pairs) {
          const rowId = randomUUID();
          await query(cols.hasAmountCents ? insertSqlCents : insertSqlUnits, [
            rowId,
            sessionId,
            p.debit_account,
            p.credit_account,
            cols.hasAmountCents ? toCents(p.amount) : Number(p.amount),
            p.narration || "",
            p.transaction_date || new Date().toISOString().slice(0,10),
            insertedDocId
          ]);
        }

        // 4) Finalize series reservation + mark snapshot used
        if (snap.reservation_id) {
          try { await finalizeReservation(snap.reservation_id); } catch {}
          await query("UPDATE series_reservations SET status='USED' WHERE reservation_id=$1", [snap.reservation_id]);
        }
        await query("UPDATE preview_snapshots SET status='USED' WHERE preview_id=$1", [previewId]);
      });

      // 5) Try to generate a human document file (non-blocking)
      let docMeta = null;
      if (insertedDocId && sDocType && sDocType !== "journal") {
        try {
          const structured = { docType: sDocType, documentFields: { [sDocType]: sDocModel } };
          if (sDocType === "invoice") docMeta = await generateInvoiceDoc({ structured });
          else if (sDocType === "receipt") docMeta = await generateReceiptDoc({ structured });
          else if (sDocType === "payment_voucher") docMeta = await generatePaymentVoucherDoc({ structured });

          if (docMeta?.filename || docMeta?.url) {
            await query("UPDATE documents SET file_url=$1 WHERE id=$2",
              [docMeta.url || docMeta.filename, insertedDocId]);
          }
        } catch (e) {
          console.warn("Document generation failed (posting already committed):", e?.message);
        }
      }

      return res.status(200).json({
        success: true,
        ok: true,
        status: "posted",
        posted: pairs.length,
        ...(insertedDocId ? {
          document: { id: insertedDocId, docType: sDocType, number: sDocModel.number || null, ...(docMeta || {}) }
        } : {})
      });
    }

    // ----- Legacy direct post path (no previewId/hash) -----
    const journal = Array.isArray(req.body?.journal) ? req.body.journal : [];
    if (!journal.length) {
      return res.status(400).json({ success:false, error: "journal[] is required when previewId/hash not provided." });
    }

    const check = await validateAndPreparePreview(journal, { allowFutureDates:false });
    if (!check.ok) {
      return res.status(422).json({ success:false, error:"Validation failed", details: check.errors || [] });
    }
    await ensureAccountsExistForJournal(check.normalized);

    const pairs = pairForLedger(check.normalized);
    if (!pairs.length) {
      return res.status(422).json({ success:false, error:"Unbalanced journal" });
    }

    await withTx(async () => {
      if (idempotencyKey) await query("INSERT OR IGNORE INTO idempotency_keys (key) VALUES ($1)", [idempotencyKey]);

      const insertSqlCents = `
        INSERT INTO ledger_entries
          (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `;
      const insertSqlUnits = `
        INSERT INTO ledger_entries
          (id, session_id, debit_account, credit_account, amount, narration, transaction_date, document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `;
      for (const p of pairs) {
        const rowId = randomUUID();
        await query(cols.hasAmountCents ? insertSqlCents : insertSqlUnits, [
          rowId, sessionId, p.debit_account, p.credit_account,
          cols.hasAmountCents ? toCents(p.amount) : Number(p.amount),
          p.narration || "", p.transaction_date || new Date().toISOString().slice(0,10), null
        ]);
      }
    });

    return res.status(200).json({ success:true, ok:true, status:"posted", posted: pairs.length });
  } catch (err) {
    console.error("Error in confirmAndSaveEntry:", err);
    return res.status(500).json({ success:false, error: err?.message || "Failed to confirm and save journal entry." });
  }
};
