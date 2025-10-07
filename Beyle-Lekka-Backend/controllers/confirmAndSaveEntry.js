// controllers/confirmAndSaveEntry.js
// Atomic posting; tenant-safe; green-only gate; strict idempotency; mapping-aware.
// Truth-in-preview preserved: we do NOT mutate the previewed journal at confirm time.

import { query, withTx } from "../services/db.js";
import { randomUUID, createHash } from "crypto";

import { runValidation } from "../utils/validation/index.js";
import { pairForLedger } from "../utils/jeCore.js";

import {
  ensureLedgerExists,
  ensureLedgerExistsWithMapping
} from "../utils/coaService.js";

import { generateInvoiceDoc } from "../utils/docGenerators/invoice.js";
import { generateReceiptDoc } from "../utils/docGenerators/receipt.js";
import { generatePaymentVoucherDoc } from "../utils/docGenerators/paymentVoucher.js";

import { getSnapshot } from "../utils/preview/snapshotStore.js";
import { finalizeReservation } from "../services/series.js";
import { releaseFundsHolds } from "../utils/preview/fundsHolds.js";

/* ------------------------ date helpers (parity with orchestrator) ------------------------ */

const DEFAULT_TZ = "Asia/Kolkata";

function todayISOInTZ(tz = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dateShiftFromTZ(days = 0, tz = DEFAULT_TZ) {
  const [y, m, d] = todayISOInTZ(tz).split("-").map(Number);
  const baseUTC = Date.UTC(y, m - 1, d);
  const shifted = new Date(baseUTC + days * 86400000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseRelativeDateFrom(raw, tz = DEFAULT_TZ) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (/\btoday\b/.test(s)) return todayISOInTZ(tz);
  if (/\byesterday\b/.test(s)) return dateShiftFromTZ(-1, tz);
  if (/\bday\s+before\s+yesterday\b/.test(s)) return dateShiftFromTZ(-2, tz);
  if (/\btomorrow\b/.test(s)) return dateShiftFromTZ(+1, tz); // clamped later
  const m = s.match(/\b(\d{1,3})\s*day(?:s)?\s*(?:ago|back|before)\b/);
  if (m) { const n = Number(m[1]); if (Number.isFinite(n)) return dateShiftFromTZ(-n, tz); }
  const m2 = s.match(/\bin\s+(\d{1,3})\s*day(?:s)?\b/);
  if (m2) { const n = Number(m2[1]); if (Number.isFinite(n)) return dateShiftFromTZ(+n, tz); }
  return null;
}

async function getWorkspaceBooksStartDateOptional(sessionId) {
  try {
    const mod = await import("../services/workspaceSettings.js");
    const fn = mod.getBooksStartDate || mod.getWorkspaceBooksStartDate || null;
    if (typeof fn === "function") {
      const v = await fn(sessionId);
      if (typeof v === "string" && v) return v.slice(0, 10);
    }
  } catch { /* not exported in some builds */ }
  return null;
}

function clampToBooksWindow(dateISO, booksStartISO = null, tz = DEFAULT_TZ) {
  const today = todayISOInTZ(tz);
  let d = isISODate(dateISO) ? dateISO : today;
  if (booksStartISO && isISODate(booksStartISO) && d < booksStartISO) d = booksStartISO;
  if (d > today) d = today;
  return d;
}

/**
 * Normalize a posting/preview date safely:
 * - If ISO: keep it.
 * - Else: resolve relative (today/yesterday/N days ago), else today.
 * - Finally clamp to [booksStart, today] if booksStart available.
 * NOTE: For snapshot flow we only use this when date is missing/invalid, to honor "truth in preview".
 */
async function normalizeDateSafely(candidate, { sessionId, tz = DEFAULT_TZ } = {}) {
  const booksStart = sessionId ? await getWorkspaceBooksStartDateOptional(sessionId) : null;
  let d = null;
  if (isISODate(candidate)) d = candidate;
  else d = parseRelativeDateFrom(candidate, tz) || todayISOInTZ(tz);
  return clampToBooksWindow(d, booksStart, tz);
}

/* ------------------------ env gates ------------------------ */

function isTrueEnv(name, def = "false") {
  const v = String(process.env[name] ?? def).toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function checkWriteGates() {
  if (isTrueEnv("MAINTENANCE_MODE", "false")) {
    const err = new Error("System under maintenance");
    err.http = 503;
    throw err;
  }
  if (isTrueEnv("READ_ONLY", "false")) {
    const err = new Error("Server is in read-only mode");
    err.http = 423;
    throw err;
  }
}

/* ------------------------ helpers ------------------------ */

const toCents = (v) => {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return Math.round(v * 100);
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

// Ensure COA accounts exist for THIS tenant (sid) by name only (legacy rows)
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

  // Prefer new column name from 020, fallback to legacy
  const ledgerHashColumn = led.has("uniq_hash")
    ? "uniq_hash"
    : (led.has("content_hash") ? "content_hash" : null);

  return {
    // ledger
    hasAmountCents: led.has("amount_cents"),
    hasAmount: led.has("amount"),
    ledgerHasSession: led.has("session_id"),
    ledgerHasHash: !!ledgerHashColumn,
    ledgerHashColumn,

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

/* ------------------------ idempotency & duplicates ------------------------ */

async function idempotencyKeyExists(key, sid, flags) {
  if (!key) return false;
  try {
    if (flags.idemHasSession) {
      const r = await query(
        `SELECT 1 FROM idempotency_keys WHERE key=$1 AND session_id=$2 LIMIT 1`,
        [key, sid]
      );
      return !!(r.rows && r.rows.length);
    }
    const r = await query(`SELECT 1 FROM idempotency_keys WHERE key=$1 LIMIT 1`, [key]);
    return !!(r.rows && r.rows.length);
  } catch {
    return false;
  }
}

// Per-tenant idempotency (if supported)
async function upsertIdempotencyKey(key, sid, flags) {
  if (!key) return;
  if (await idempotencyKeyExists(key, sid, flags)) {
    const err = new Error("Duplicate idempotency key");
    err.http = 409;
    throw err;
  }
  try {
    if (flags.idemHasSession) {
      await query(
        `INSERT INTO idempotency_keys (key, session_id)
         VALUES ($1,$2)
         ON CONFLICT(key, session_id) DO NOTHING`,
        [key, sid]
      );
    } else {
      await query(
        `INSERT INTO idempotency_keys (key)
         VALUES ($1)
         ON CONFLICT(key) DO NOTHING`,
        [key]
      );
    }
  } catch {
    // SQLite fallback
    try {
      if (flags.idemHasSession) {
        await query(
          `INSERT OR IGNORE INTO idempotency_keys (key, session_id) VALUES ($1,$2)`,
          [key, sid]
        );
      } else {
        await query(`INSERT OR IGNORE INTO idempotency_keys (key) VALUES ($1)`, [key]);
      }
    } catch {}
  }
}

function contentHashOfPair(sid, pair, useCents) {
  const d = String(pair.transaction_date || "").slice(0, 10);
  const da = String(pair.debit_account || "").trim().toLowerCase();
  const ca = String(pair.credit_account || "").trim().toLowerCase();
  const narr = String(pair.narration || "").trim();
  const amtC = useCents ? toCents(pair.amount) : null;
  const amtU = useCents ? null : Number(pair.amount || 0).toFixed(2);
  const base = useCents
    ? [sid, d, da, ca, amtC, narr].join("|")
    : [sid, d, da, ca, amtU, narr].join("|");
  return createHash("sha256").update(base).digest("hex");
}

async function entryPairExists(pair, sid, flags) {
  // Hash fast-path if column exists
  if (flags.ledgerHashColumn) {
    const h = contentHashOfPair(sid, pair, !!flags.hasAmountCents);
    const hashCol = flags.ledgerHashColumn;
    try {
      const r = await query(
        `SELECT 1 FROM ledger_entries WHERE session_id=$1 AND ${hashCol}=$2 LIMIT 1`,
        [sid, h]
      );
      return !!(r.rows && r.rows.length);
    } catch {
      const r2 = await query(
        `SELECT 1 FROM ledger_entries WHERE session_id=? AND ${hashCol}=? LIMIT 1`,
        [sid, h]
      );
      return !!(r2.rows && r2.rows.length);
    }
  }

  const dateISO = (pair.transaction_date || "").slice(0, 10);
  const params = [sid, pair.debit_account, pair.credit_account, dateISO, pair.narration || ""];
  try {
    if (flags.hasAmountCents) {
      const q = `
        SELECT 1 FROM ledger_entries
         WHERE session_id=$1
           AND debit_account=$2
           AND credit_account=$3
           AND transaction_date=$4
           AND narration=$5
           AND amount_cents=$6
         LIMIT 1`;
      const r = await query(q, [...params, toCents(pair.amount)]);
      return !!(r.rows && r.rows.length);
    } else {
      const q = `
        SELECT 1 FROM ledger_entries
         WHERE session_id=$1
           AND debit_account=$2
           AND credit_account=$3
           AND transaction_date=$4
           AND narration=$5
           AND ROUND(COALESCE(amount,0)::numeric, 2) = ROUND($6::numeric, 2)
         LIMIT 1`;
      const r = await query(q, [...params, Number(pair.amount || 0)]);
      return !!(r.rows && r.rows.length);
    }
  } catch {
    // SQLite compatible
    if (flags.hasAmountCents) {
      const r2 = await query(
        `SELECT 1 FROM ledger_entries
           WHERE session_id=? AND debit_account=? AND credit_account=?
             AND transaction_date=? AND narration=? AND amount_cents=? LIMIT 1`,
        [sid, pair.debit_account, pair.credit_account, dateISO, pair.narration || "", toCents(pair.amount)]
      );
      return !!(r2.rows && r2.rows.length);
    } else {
      const amt = Number(pair.amount || 0).toFixed(2);
      const r2 = await query(
        `SELECT 1 FROM ledger_entries
           WHERE session_id=? AND debit_account=? AND credit_account=?
             AND transaction_date=? AND narration=? AND ROUND(amount,2)=ROUND(?,2) LIMIT 1`,
        [sid, pair.debit_account, pair.credit_account, dateISO, pair.narration || "", Number(amt)]
      );
      return !!(r2.rows && r2.rows.length);
    }
  }
}

/* ------------------------ mapping-aware ensure (best effort) ------------------------ */

async function applyFamilyMappingCoA({ mappingLines = [], sessionId }) {
  if (!Array.isArray(mappingLines) || mappingLines.length === 0) return;

  for (const ln of mappingLines) {
    try {
      const m = ln?.mapping || {};
      const fam = String(m.family_code || "").trim();
      if (!fam) continue;

      const childRaw =
        typeof m.child_display === "string" && m.child_display.trim()
          ? m.child_display.trim()
          : null;

      await ensureLedgerExistsWithMapping(childRaw, sessionId, {
        family_code: fam,
        type: m.type || null,
        normal_balance: m.normal_balance || null,
        source: ln?.source || "llm",
        rationale: ln?.rationale || null,
        allowParentPosting: !childRaw
      });
    } catch (e) {
      console.warn("Mapping ensure (best-effort) failed:", e?.message || e);
    }
  }
}

/* ------------------------ validation wrapper ------------------------ */

async function greenOnlyValidate({ docType, journal, docModel, sessionId }) {
  try {
    const v = await runValidation({
      docType: docType || "journal",
      journal,
      docModel,
      tz: DEFAULT_TZ,
      mode: "post",
      sessionId
    });
    const hard = Array.isArray(v?.errors) ? v.errors.filter(e => e && e.level !== "warn") : [];
    return { ok: !(hard && hard.length), report: v };
  } catch {
    const v = await runValidation({
      docType: docType || "journal",
      journal,
      docModel,
      tz: DEFAULT_TZ,
      mode: "preview",
      sessionId
    });
    const hard = Array.isArray(v?.errors) ? v.errors.filter(e => e && e.level !== "warn") : [];
    return { ok: !(hard && hard.length), report: v };
  }
}

/* ------------------------ main ------------------------ */

export const confirmAndSaveEntry = async (req, res) => {
  try {
    checkWriteGates();

    if (typeof req.sessionId === "undefined") {
      return res
        .status(500)
        .json({ success: false, ok: false, error: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId;
    if (sid === null) {
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
      if (flags.snapsHasSession && snap.session_id && snap.session_id !== sid) {
        return res.status(409).json({ success: false, error: "Preview belongs to another workspace" });
      }

      if (idempotencyKey && await idempotencyKeyExists(idempotencyKey, sid, flags)) {
        return res.status(409).json({ success: false, error: "Duplicate idempotency key" });
      }

      const payload = snap.payload || {};
      const sDocType = payload.docType || "journal";
      const sDocModel = payload.docModel || {};
      const sJournal = Array.isArray(payload.journal) ? payload.journal : [];
      const sMapping = Array.isArray(payload.familyMapping) ? payload.familyMapping : [];

      // Build doc model: respect previewed date; normalize ONLY if missing/invalid
      let finalDocDate = isISODate(sDocModel.date)
        ? sDocModel.date.slice(0, 10)
        : await normalizeDateSafely(sDocModel.date, { sessionId: sid, tz: DEFAULT_TZ });

      const docModel = {
        ...sDocModel,
        date: finalDocDate
      };

      // Green-only gate: revalidate before posting
      const pairsForCheck = pairForLedger(sJournal);
      if (!pairsForCheck.length) {
        return res.status(422).json({ success: false, error: "Snapshot journal unbalanced or empty." });
      }
      const { ok: green, report } = await greenOnlyValidate({
        docType: sDocType,
        journal: sJournal,
        docModel,
        sessionId: sid
      });
      if (!green) {
        return res.status(409).json({
          success: false,
          error: "Preview no longer green; please re-preview.",
          validation: report
        });
      }

      // Ensure tenant-scoped ledgers exist — mapping first (best effort), then legacy names.
      await applyFamilyMappingCoA({ mappingLines: sMapping, sessionId: sid });
      await ensureAccountsExistForJournal(sJournal, sid);

      const pairs = pairsForCheck;

      // Duplicate content check per pair
      for (const p of pairs) {
        if (await entryPairExists(p, sid, flags)) {
          return res.status(409).json({
            success: false,
            error: "Duplicate journal detected (same date, accounts, amount, narration)."
          });
        }
      }

      const useCents = !!flags.hasAmountCents;
      const contentHashes = pairs.map(p => contentHashOfPair(sid, p, useCents));

      let insertedDocId = null;

      await withTx(async () => {
        // 0) Release preview holds (non-fatal if fails)
        try { await releaseFundsHolds({ sessionId: sid, previewId }); }
        catch (e) { console.warn("Funds holds release failed (non-fatal):", e?.message || e); }

        // 1) Idempotency insert
        await upsertIdempotencyKey(idempotencyKey, sid, flags);

        // 2) Insert document row (if any)
        if (sDocType && sDocType !== "journal" && (sDocModel.number || sDocModel.date)) {
          insertedDocId = randomUUID();
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
          const vals = [insertedDocId, sDocType, sDocModel.number || null, finalDocDate, party];

          if (flags.docHasGrossAmountCents) { cols.push("gross_amount_cents"); vals.push(grossCents); }
          else if (flags.docHasGrossAmount) { cols.push("gross_amount"); vals.push(grossUnits || null); }

          cols.push("status", "file_url");
          vals.push("FINALIZED", null);

          if (flags.docHasCreatedBy) { cols.push("created_by"); vals.push(req.body?.userId || null); }
          if (flags.docHasSession)   { cols.push("session_id"); vals.push(sid); }

          const ph = cols.map((_, i) => `$${i + 1}`).join(",");
          await query(`INSERT INTO documents (${cols.join(",")}) VALUES (${ph})`, vals);
        }

        // 3) Insert ledger entries
        const hashCol = flags.ledgerHashColumn; // "uniq_hash" | "content_hash" | null
        const insertSqlCents = `
          INSERT INTO ledger_entries
            (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, document_id${hashCol ? `, ${hashCol}` : ""})
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hashCol ? ",$9" : ""})
        `;
        const insertSqlUnits = `
          INSERT INTO ledger_entries
            (id, session_id, debit_account, credit_account, amount, narration, transaction_date, document_id${hashCol ? `, ${hashCol}` : ""})
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hashCol ? ",$9" : ""})
        `;

        for (let i = 0; i < pairs.length; i++) {
          const p = pairs[i];
          const rowId = randomUUID();
          const txnDate = isISODate(p.transaction_date) ? p.transaction_date.slice(0,10) : finalDocDate;
          const baseParams = [
            rowId,
            sid,
            p.debit_account,
            p.credit_account,
            flags.hasAmountCents ? toCents(p.amount) : Number(p.amount),
            p.narration || "",
            txnDate,
            insertedDocId
          ];
          const params = hashCol ? [...baseParams, contentHashes[i]] : baseParams;

          await query(flags.hasAmountCents ? insertSqlCents : insertSqlUnits, params);
        }

        // 4) Finalize series reservation + mark snapshot used
        if (snap.reservation_id) {
          try {
            await finalizeReservation({ reservationId: snap.reservation_id, sessionId: sid });
          } catch {}
          let sql = `UPDATE series_reservations SET status='USED' WHERE reservation_id=$1`;
          const params = [snap.reservation_id];
          if (flags.seriesHasSession) { sql += ` AND session_id=$2`; params.push(sid); }
          await query(sql, params);
        }

        {
          let sql = `UPDATE preview_snapshots SET status='USED' WHERE preview_id=$1`;
          const params = [previewId];
          if (flags.snapsHasSession) { sql += ` AND session_id=$2`; params.push(sid); }
          await query(sql, params);
        }
      });

      // 5) Document generation (best-effort)
      let docMeta = null;
      if (insertedDocId && sDocType && sDocType !== "journal") {
        try {
          const structured = { docType: sDocType, documentFields: { [sDocType]: sDocModel } };
          if (sDocType === "invoice") docMeta = await generateInvoiceDoc({ structured });
          else if (sDocType === "receipt") docMeta = await generateReceiptDoc({ structured });
          else if (sDocType === "payment_voucher") docMeta = await generatePaymentVoucherDoc({ structured });

          if (docMeta?.filename || docMeta?.url) {
            let sql = `UPDATE documents SET file_url=$1 WHERE id=$2`;
            const params = [docMeta.url || docMeta.filename, insertedDocId];
            if (flags.docHasSession) { sql += ` AND session_id=$3`; params.push(sid); }
            await query(sql, params);
          }
        } catch (e) {
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
    const firstDateRaw = journal.find(l => typeof l?.date === "string" && l.date)?.date;
    const normalizedDate = await normalizeDateSafely(firstDateRaw, { sessionId: sid, tz: DEFAULT_TZ });
    const docModel = { date: normalizedDate };

    // Green-only gate for direct post
    const { ok: green, report } = await greenOnlyValidate({
      docType: "journal",
      journal,
      docModel,
      sessionId: sid
    });
    if (!green) {
      return res.status(409).json({
        success: false,
        error: "Journal not green; please run preview and fix errors first.",
        validation: report
      });
    }

    // Ensure ledgers exist for this tenant only after validation passes
    await ensureAccountsExistForJournal(journal, sid);

    // Use docModel.date as fallback txn date so preview/post parity is maintained
    const pairs = pairForLedger(journal).map(p => ({
      ...p,
      transaction_date: isISODate(p.transaction_date) ? p.transaction_date.slice(0,10) : normalizedDate
    }));
    if (!pairs.length) {
      return res.status(422).json({ success: false, error: "Unbalanced journal" });
    }

    // Duplicate content check per pair (strict)
    for (const p of pairs) {
      if (await entryPairExists(p, sid, flags)) {
        return res.status(409).json({
          success: false,
          error: "Duplicate journal detected (same date, accounts, amount, narration)."
        });
      }
    }

    // Idempotency: reject if key was already used for this tenant
    const { idempotencyKey: idemDirect } = req.body || {};
    if (idemDirect && await idempotencyKeyExists(idemDirect, sid, flags)) {
      return res.status(409).json({ success: false, error: "Duplicate idempotency key" });
    }

    // Optional content hash for storage
    const useCents = !!flags.hasAmountCents;
    const contentHashes = pairs.map(p => contentHashOfPair(sid, p, useCents));

    await withTx(async () => {
      await upsertIdempotencyKey(idemDirect, sid, flags);

      const hashCol = flags.ledgerHashColumn;

      const insertSqlCents = `
        INSERT INTO ledger_entries
          (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, document_id${hashCol ? `, ${hashCol}` : ""})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hashCol ? ",$9" : ""})
      `;
      const insertSqlUnits = `
        INSERT INTO ledger_entries
          (id, session_id, debit_account, credit_account, amount, narration, transaction_date, document_id${hashCol ? `, ${hashCol}` : ""})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hashCol ? ",$9" : ""})
      `;

      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const rowId = randomUUID();
        const txnDate = isISODate(p.transaction_date) ? p.transaction_date.slice(0,10) : normalizedDate;
        const baseParams = [
          rowId,
          sid,
          p.debit_account,
          p.credit_account,
          flags.hasAmountCents ? toCents(p.amount) : Number(p.amount),
          p.narration || "",
          txnDate,
          null
        ];
        const params = hashCol ? [...baseParams, contentHashes[i]] : baseParams;

        await query(flags.hasAmountCents ? insertSqlCents : insertSqlUnits, params);
      }
    });

    return res.status(200).json({ success: true, ok: true, status: "posted", posted: pairs.length });
  } catch (err) {
    const code = Number(err?.http) || 500;
    console.error("Error in confirmAndSaveEntry:", err);
    return res.status(code).json({
      success: false,
      error: err?.message || "Failed to confirm and save journal entry.",
    });
  }
};
