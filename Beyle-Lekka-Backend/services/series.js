// services/series.js
import { query } from "./db.js";
import { randomUUID } from "crypto";

/**
 * FY derivation (calendar year by default).
 * If/when you add FY policy (e.g., Apr–Mar), route through here.
 */
function fyFromDate(dISO) {
  const y = Number(dISO?.slice(0, 4));
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

/** Map inbound doc types to canonical series types. */
function canonicalType(docType) {
  const t = String(docType || "").toLowerCase();
  if (t === "payment_voucher") return "voucher";        // keep PV series
  if (t === "contra_voucher") return "contra_voucher";  // dedicated CV series
  if (t === "journal") return "journal";                // if you number JVs
  if (t === "invoice") return "invoice";
  if (t === "receipt") return "receipt";
  return t || "voucher";
}

/** Prefix map for each canonical type. */
function prefixForType(t) {
  switch (t) {
    case "invoice":         return "INV";
    case "receipt":         return "RCT";
    case "voucher":         return "PV";
    case "contra_voucher":  return "CV";
    case "journal":         return "JV";
    default:                return "DOC";
  }
}

/** Require a valid tenant/session. Fail-fast for pilot/prod. */
function requireSession(sessionId) {
  const sid = sessionId ?? null;
  if (!sid) {
    throw new Error(
      "[series] Missing sessionId. Pass req.sessionId (X-Workspace-Id) to numbering APIs."
    );
  }
  return sid;
}

/**
 * Create tables/indexes if missing (multi-tenant shape).
 * NOTE: If an older (non-tenant) table exists, this won't alter it.
 * assertTenantSchema() below will detect and fail fast so you can run the migration.
 */
async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS document_series (
      session_id TEXT NOT NULL,
      doc_type   TEXT NOT NULL,
      prefix     TEXT NOT NULL,
      year       INTEGER NOT NULL,
      curr       INTEGER NOT NULL,
      PRIMARY KEY (session_id, doc_type, year)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS series_reservations (
      reservation_id TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      doc_type       TEXT NOT NULL,
      fy             INTEGER NOT NULL,
      number         TEXT NOT NULL,
      preview_id     TEXT,
      status         TEXT NOT NULL,     -- 'HELD' | 'USED' | 'EXPIRED'
      expires_at     TEXT NOT NULL
    )
  `);

  // One number per (tenant, type, FY)
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_series_res_sid
    ON series_reservations (session_id, doc_type, fy, number)
  `);
}

/** Detect old schema (no session_id) and abort with a clear message. */
async function assertTenantSchema() {
  try {
    // Will throw if session_id column doesn't exist (both SQLite & Postgres)
    await query(`SELECT 1 FROM document_series WHERE session_id IS NOT NULL LIMIT 1`);
    await query(`SELECT 1 FROM series_reservations WHERE session_id IS NOT NULL LIMIT 1`);
  } catch (err) {
    const e = new Error(
      "[series] Multi-tenant schema missing. Run the migration that adds session_id to document_series and series_reservations (see 019_multitenant_hardening.sql)."
    );
    e.cause = err;
    throw e;
  }
}

/**
 * Ensure a row exists for (session, type, FY). Idempotent.
 */
export async function ensureSeriesRow(docType, sessionId, fy = new Date().getFullYear()) {
  await ensureTables();
  await assertTenantSchema();

  const sid = requireSession(sessionId);
  const t = canonicalType(docType);

  const existing = await query(
    `SELECT 1 FROM document_series WHERE session_id = $1 AND doc_type = $2 AND year = $3`,
    [sid, t, fy]
  );

  if (!existing.rows || existing.rows.length === 0) {
    await query(
      `INSERT INTO document_series (session_id, doc_type, prefix, year, curr)
       VALUES ($1, $2, $3, $4, 0)`,
      [sid, t, prefixForType(t), fy]
    );
  }
}

/**
 * Reserve the next number for a doc type (per tenant + year).
 * - Bumps the counter atomically per (session_id, doc_type, year).
 * - Creates a HELD reservation tied to the preview (idempotent at the call-site).
 * - Returns: { reservationId, number, expiresAt, sessionId }
 *
 * Call-site MUST pass sessionId from tenant middleware.
 */
export async function reserveSeries({
  docType,
  dateISO,
  previewId,
  ttlSec = 1800,
  sessionId
}) {
  await ensureTables();
  await assertTenantSchema();

  const sid = requireSession(sessionId);
  const t = canonicalType(docType);
  const fy = fyFromDate(dateISO);

  // Ensure series row exists for this (tenant, type, year)
  await ensureSeriesRow(t, sid, fy);

  // 1) Bump the counter (per-tenant, per-year)
  await query(
    `UPDATE document_series
       SET curr = curr + 1
     WHERE session_id = $1 AND doc_type = $2 AND year = $3`,
    [sid, t, fy]
  );

  // 2) Read back the new prefix/year/curr
  const r = await query(
    `SELECT prefix, year, curr
       FROM document_series
      WHERE session_id = $1 AND doc_type = $2 AND year = $3`,
    [sid, t, fy]
  );
  const { prefix, year, curr } = r.rows?.[0] || {};
  if (curr == null) {
    throw new Error("[series] Failed to read series counter after update.");
  }

  // Number style kept backward-compatible: PREFIX-YYYY-00000
  const number = `${prefix}-${year}-${String(curr).padStart(5, "0")}`;

  // 3) Hold the specific number for this preview
  const reservationId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSec * 1000).toISOString();

  await query(
    `INSERT INTO series_reservations
       (reservation_id, session_id, doc_type, fy, number, preview_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'HELD', $7)`,
    [reservationId, sid, t, fy, number, previewId || null, expiresAt]
  );

  return { reservationId, number, expiresAt, sessionId: sid };
}

/**
 * Mark a reservation as USED (tenant-guarded).
 */
export async function finalizeReservation(reservationId, sessionId) {
  const sid = requireSession(sessionId);
  await query(
    `UPDATE series_reservations SET status = 'USED'
      WHERE reservation_id = $1 AND session_id = $2`,
    [reservationId, sid]
  );
}

/**
 * Optional: cancel a reservation (mark EXPIRED) if a preview was abandoned.
 */
export async function cancelReservation(reservationId, sessionId) {
  const sid = requireSession(sessionId);
  await query(
    `UPDATE series_reservations SET status = 'EXPIRED'
      WHERE reservation_id = $1 AND session_id = $2`,
    [reservationId, sid]
  );
}

/**
 * Optional: housekeeping to expire stale HELD reservations (run on a timer/cron).
 */
export async function expireStaleReservations(nowISO = new Date().toISOString()) {
  await query(
    `UPDATE series_reservations
        SET status = 'EXPIRED'
      WHERE status = 'HELD' AND expires_at < $1`,
    [nowISO]
  );
}

/**
 * Convenience helper: immediately get a number (auto-expires the hold almost instantly).
 * Prefer reserveSeries + finalizeReservation in normal flows.
 */
export async function getNextNumber(docType, dateISO, sessionId) {
  const { number } = await reserveSeries({
    docType,
    dateISO,
    previewId: randomUUID(),
    ttlSec: 1,
    sessionId
  });
  return number;
}
