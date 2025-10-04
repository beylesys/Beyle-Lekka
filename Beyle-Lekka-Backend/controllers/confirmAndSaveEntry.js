// controllers/confirmAndSaveEntry.js
// Atomic posting; tenant-safe; supports cents-based storage if present; robust column + dialect detection (SQLite & Postgres).

import { query, withTx } from "../services/db.js";
import { randomUUID } from "crypto";

// NOTE: we no longer use validateAndPreparePreview() here because we want the same validation
// stack used in preview (including funds/facility guard). Use runValidation instead.
import { runValidation } from "../utils/validation/index.js";

import { pairForLedger } from "../utils/jeCore.js";
import { ensureLedgerExists } from "../utils/coaService.js";

import { generateInvoiceDoc } from "../utils/docGenerators/invoice.js";
import { generateReceiptDoc } from "../utils/docGenerators/receipt.js";
import { generatePaymentVoucherDoc } from "../utils/docGenerators/paymentVoucher.js";

import { getSnapshot } from "../utils/preview/snapshotStore.js";
import { finalizeReservation } from "../services/series.js";

// NEW: release preview holds so DB guard triggers don't block our own post
import { releaseFundsHolds } from "../utils/preview/fundsHolds.js";

/* ------------------------ helpers ------------------------ */

const toCents = (v) => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.round(v * 100);
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// Ensure COA accounts exist for THIS tenant (sid)
async function ensureAccountsExistForJournal(journal, sid) {
  const seen = new Set();
  for (const e of journal || []) {
    if (e && typeof e.account === "string") {
      const name = e.account.trim();
      if (name && !seen.has(name)) {
        await ensureLedgerExists(name, sid); // tenant-aware
        seen.add(name);
      }
    }
  }
}

/* ---------- robust, cached column detection (PG + SQLite) ---------- */

const _columnsCache = new Map(); // table -> Set(columns)

function safeIdent(t) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`Invalid identifier: ${t}`);
  return t;
}

async function columnsOf(table) {
  const key = table.toLowerCase();
  if (_columnsCache.has(key)) return _columnsCache.get(key);

  const t = safeIdent(table);
  let cols = new Set();

  // Try Postgres information_schema first
  try {
    const r = await query(
      `SELECT lower(column_name) AS name
         FROM information_schema.columns
        WHERE lower(table_name) = lower($1)`,
      [t]
    );
    if (Array.isArray(r.rows) && r.rows.length) {
      cols = new Set(r.rows.map((x) => x.name));
      _columnsCache.set(key, cols);
      return cols;
    }
  } catch (_) {}

  // Fallback: SQLite PRAGMA (must interpolate identifier; we validated it)
  try {
    const r2 = await query(`PRAGMA table_info(${t})`);
    if (Array.isArray(r2.rows) && r2.rows.length) {
      cols = new Set(
        r2.rows.map((x) => String(x.name ?? x.NAME ?? "").toLowerCase()).filter(Boolean)
      );
    }
  } catch (_) {}

  _columnsCache.set(key, cols);
  return cols;
}

async function detectColumns() {
  const led = await columnsOf("ledger_entries");
  const doc = await columnsOf("documents");
  const idem = await columnsOf("idempotency_keys");
  const series = await columnsOf("series_reservations");
  const snaps = await columnsOf("preview_snapshots");

  return {
    // ledger
    hasAmountCents: led.has("amount_cents"),
    hasAmount: led.has("amount"),
    ledgerHasSession: led.has("session_id"),
    // documents
    docHasGrossAmountCents: doc.has("gross_amount_cents"),
    docHasGrossAmount: doc.has("gross_amount"),
    docHasSession: doc.has("session_id"),
    docHasCreatedBy: doc.has("created_by"),
    // idempotency
    idemHasSession: idem.has("session_id"),
    // series/snapshots
    seriesHasSession: series.has("session_id"),
    snapsHasSession: snaps.has("session_id"),
  };
}

// Per-tenant idempotency (if supported)
async function upsertIdempotencyKey(key, sid, flags) {
  if (!key) return;
  const { idemHasSession } = flags || {};
  try {
    if (idemHasSession) {
      // Postgres preferred
      await query(
        `INSERT INTO idempotency_keys (key, session_id) VALUES ($1,$2)
         ON CONFLICT(key, session_id) DO NOTHING`,
        [key, sid]
      );
    } else {
      await query(
        `INSERT INTO idempotency_keys (key) VALUES ($1)
         ON CONFLICT(key) DO NOTHING`,
        [key]
      );
    }
  } catch {
    // SQLite fallback
    try {
      if (idemHasSession) {
        await query(`INSERT OR IGNORE INTO idempotency_keys (key, session_id) VALUES ($1,$2)`, [
          key,
          sid,
        ]);
      } else {
        await query(`INSERT OR IGNORE INTO idempotency_keys (key) VALUES ($1)`, [key]);
      }
    } catch {
      // ignore
    }
  }
}

/* ------------------------ main ------------------------ */

export const confirmAndSaveEntry = async (req, res) => {
  try {
    if (typeof req.sessionId === "undefined") {
      return res
        .status(500)
        .json({ success: false, ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId; // string for tenant, null for admin ALL
    if (sid === null) {
      // Writes must be scoped to a concrete tenant
      return res
        .status(400)
        .json({ success: false, ok: false, error: "Workspace context required for posting." });
    }

    const { previewId, hash, idempotencyKey } = req.body || {};
    const flags = await detectColumns();

    // -------- Snapshot flow (preview -> confirm) --------
    if (previewId && hash) {
      const snap = await getSnapshot(previewId);
      if (!snap || snap.status !== "ACTIVE") {
        return res.status(410).json({ success: false, error: "Preview expired or already used" });
      }
      if (String(snap.hash) !== String(hash)) {
        return res
          .status(409)
          .json({ success: false, error: "Preview content changed; re-preview required" });
      }
      // If snapshots are tenant-scoped, enforce same-tenant posting
      if (flags.snapsHasSession && snap.session_id && snap.session_id !== sid) {
        return res.status(409).json({ success: false, error: "Preview belongs to another workspace" });
      }

      const payload = snap.payload || {};
      const sDocType = payload.docType || "journal";
      const sDocModel = payload.docModel || {};
      const sJournal = Array.isArray(payload.journal) ? payload.journal : [];

      // IMPORTANT: We DO NOT mutate narrations here. What was previewed is what gets posted.
      // Ensure tenant-scoped ledgers exist
      await ensureAccountsExistForJournal(sJournal, sid);

      // Pair exactly as previewed
      const pairs = pairForLedger(sJournal);
      if (!pairs.length) {
        return res
          .status(422)
          .json({ success: false, error: "Snapshot journal unbalanced or empty." });
      }

      let insertedDocId = null;

      await withTx(async () => {
        // 0) Release our own preview holds so DB guard triggers don't subtract them
        try {
          await releaseFundsHolds({ sessionId: sid, previewId });
        } catch (e) {
          // Non-fatal; DB trigger still protects overall integrity
          // eslint-disable-next-line no-console
          console.warn("Funds holds release failed (non-fatal):", e?.message || e);
        }

        // 1) Idempotency (per-tenant if supported)
        await upsertIdempotencyKey(idempotencyKey, sid, flags);

        // 2) Insert the document row (if any), stamping session when supported
        if (sDocType && sDocType !== "journal" && (sDocModel.number || sDocModel.date)) {
          insertedDocId = randomUUID();
          const dateISO = (sDocModel.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
          const party =
            sDocModel.party ||
            sDocModel.customer ||
            sDocModel.buyer ||
            sDocModel.buyerName ||
            sDocModel.vendor ||
            null;

          const grossUnits = sDocModel.total != null ? Number(sDocModel.total) : null;
          const grossCents = grossUnits != null ? toCents(grossUnits) : null;

          const cols = ["id", "doc_type", "number", "date", "party_name"];
          const vals = [insertedDocId, sDocType, sDocModel.number || null, dateISO, party];

          if (flags.docHasGrossAmountCents) {
            cols.push("gross_amount_cents");
            vals.push(grossCents);
          } else if (flags.docHasGrossAmount) {
            cols.push("gross_amount");
            vals.push(grossUnits || null);
          }

          cols.push("status", "file_url");
          vals.push("FINALIZED", null);

          if (flags.docHasCreatedBy) {
            cols.push("created_by");
            vals.push(req.body?.userId || null);
          }
          if (flags.docHasSession) {
            cols.push("session_id");
            vals.push(sid);
          }

          const ph = cols.map((_, i) => `$${i + 1}`).join(",");
          await query(`INSERT INTO documents (${cols.join(",")}) VALUES (${ph})`, vals);
        }

        // 3) Insert ledger entries (amount_cents if present; else amount) — always stamp session_id
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
          await query(flags.hasAmountCents ? insertSqlCents : insertSqlUnits, [
            rowId,
            sid, // tenant
            p.debit_account,
            p.credit_account,
            flags.hasAmountCents ? toCents(p.amount) : Number(p.amount),
            p.narration || "",
            p.transaction_date || new Date().toISOString().slice(0, 10),
            insertedDocId,
          ]);
        }

        // 4) Finalize series reservation + mark snapshot used (scoped when supported)
        if (snap.reservation_id) {
          try {
            await finalizeReservation(snap.reservation_id);
          } catch {}
          let sql = `UPDATE series_reservations SET status='USED' WHERE reservation_id=$1`;
          const params = [snap.reservation_id];
          if (flags.seriesHasSession) {
            sql += ` AND session_id=$2`;
            params.push(sid);
          }
          await query(sql, params);
        }

        {
          let sql = `UPDATE preview_snapshots SET status='USED' WHERE preview_id=$1`;
          const params = [previewId];
          if (flags.snapsHasSession) {
            sql += ` AND session_id=$2`;
            params.push(sid);
          }
          await query(sql, params);
        }
      });

      // 5) Document generation (best-effort, updates scoped if supported)
      let docMeta = null;
      if (insertedDocId && sDocType && sDocType !== "journal") {
        try {
          const structured = { docType: sDocType, documentFields: { [sDocType]: sDocModel } };
          if (sDocType === "invoice") docMeta = await generateInvoiceDoc({ structured });
          else if (sDocType === "receipt") docMeta = await generateReceiptDoc({ structured });
          else if (sDocType === "payment_voucher")
            docMeta = await generatePaymentVoucherDoc({ structured });

          if (docMeta?.filename || docMeta?.url) {
            let sql = `UPDATE documents SET file_url=$1 WHERE id=$2`;
            const params = [docMeta.url || docMeta.filename, insertedDocId];
            if (flags.docHasSession) {
              sql += ` AND session_id=$3`;
              params.push(sid);
            }
            await query(sql, params);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("Document generation failed (posting committed):", e?.message);
        }
      }

      return res.status(200).json({
        success: true,
        ok: true,
        status: "posted",
        posted: pairs.length,
        ...(insertedDocId
          ? {
              document: {
                id: insertedDocId,
                docType: sDocType,
                number: sDocModel.number || null,
                ...(docMeta || {}),
              },
            }
          : {}),
      });
    }

    // -------- Legacy direct post path (no previewId/hash) --------
    const journal = Array.isArray(req.body?.journal) ? req.body.journal : [];
    if (!journal.length) {
      return res.status(400).json({
        success: false,
        error: "journal[] is required when previewId/hash not provided.",
      });
    }

    // Build a minimal doc model so validation (incl. funds guard) can run
    const firstDate = journal.find(l => typeof l?.date === "string" && l.date)?.date;
    const docModel = { date: firstDate || new Date().toISOString().slice(0, 10) };

    const validation = await runValidation({
      docType: "journal",
      journal,
      docModel,
      tz: "Asia/Kolkata",
      mode: "preview",
      sessionId: sid
    });

    if (Array.isArray(validation?.errors) && validation.errors.length) {
      return res.status(422).json({
        success: false,
        error: "Validation failed",
        errors: validation.errors,
        warnings: validation.warnings || []
      });
    }

    // Ensure ledgers exist for this tenant only after validation passes
    await ensureAccountsExistForJournal(journal, sid);

    const pairs = pairForLedger(journal);
    if (!pairs.length) {
      return res.status(422).json({ success: false, error: "Unbalanced journal" });
    }

    await withTx(async () => {
      await upsertIdempotencyKey(idempotencyKey, sid, flags);

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
        await query(flags.hasAmountCents ? insertSqlCents : insertSqlUnits, [
          rowId,
          sid, // tenant
          p.debit_account,
          p.credit_account,
          flags.hasAmountCents ? toCents(p.amount) : Number(p.amount),
          p.narration || "",
          p.transaction_date || new Date().toISOString().slice(0, 10),
          null,
        ]);
      }
    });

    return res
      .status(200)
      .json({ success: true, ok: true, status: "posted", posted: pairs.length });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in confirmAndSaveEntry:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to confirm and save journal entry.",
    });
  }
};
