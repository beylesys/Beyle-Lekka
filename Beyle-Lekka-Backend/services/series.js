// services/series.js
import { query, withTx } from "./db.js";
import { randomUUID } from "crypto";

/* ------------- helpers: FY, canonical types, prefixes ------------- */

function fyFromDate(dISO) {
  const y = Number(dISO?.slice(0, 4));
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

function canonicalType(docType) {
  const t = String(docType || "").toLowerCase();
  if (t === "payment_voucher") return "voucher";
  if (t === "contra_voucher") return "contra_voucher";
  if (t === "journal") return "journal";
  if (t === "invoice") return "invoice";
  if (t === "receipt") return "receipt";
  return t || "voucher";
}

function prefixForType(t) {
  switch (t) {
    case "invoice":        return "INV";
    case "receipt":        return "RCT";
    case "voucher":        return "PV";
    case "contra_voucher": return "CV";
    case "journal":        return "JV";
    default:               return "DOC";
  }
}

function requireSession(sessionId) {
  const sid = sessionId ?? null;
  if (!sid) {
    throw new Error(
      "[series] Missing sessionId. Pass req.sessionId (X-Workspace-Id) to numbering APIs."
    );
  }
  return sid;
}

/* ------------- schema bootstrap & checks ------------- */

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

  // Per-tenant uniqueness (new); old DBs may still also have a legacy (doc_type,fy,number) unique
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_series_res_sid
      ON series_reservations (session_id, doc_type, fy, number)
  `);
}

async function assertTenantSchema() {
  try {
    await query(`SELECT 1 FROM document_series WHERE session_id IS NOT NULL LIMIT 1`);
    await query(`SELECT 1 FROM series_reservations WHERE session_id IS NOT NULL LIMIT 1`);
  } catch (err) {
    const e = new Error(
      "[series] Multi-tenant schema missing. Run the migration that adds session_id to document_series & series_reservations (see 019/020/021)."
    );
    e.cause = err;
    throw e;
  }
}

/* ------------- core ops ------------- */

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
 * Reserve the next number for a doc type (per tenant + year), retrying on conflicts.
 * Supports BOTH signatures:
 *   - reserveSeries({ docType, dateISO, previewId, ttlSec = 1800, sessionId })
 *   - reserveSeries(sessionId, docType, fy, previewId)   <-- legacy positional
 */
export async function reserveSeries(a, b, c, d) {
  // Normalize arguments
  const args = (typeof a === "object" && a !== null)
    ? a
    : { sessionId: a, docType: b, fy: c, previewId: d };

  await ensureTables();
  await assertTenantSchema();

  const sid = requireSession(args.sessionId);
  const t = canonicalType(args.docType);
  const fy = args.fy != null ? Number(args.fy) : fyFromDate(args.dateISO);
  const ttlSec = Number.isFinite(args.ttlSec) ? args.ttlSec : 1800;
  const previewId = args.previewId || null;

  await ensureSeriesRow(t, sid, fy);

  // We'll try up to N times in case of concurrent callers or legacy global unique constraints.
  const MAX_TRIES = 50;

  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const reservationId = randomUUID();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

    // Single transaction: bump -> read -> attempt insert (ignore on conflict)
    const inserted = await withTx(async () => {
      // 1) bump
      await query(
        `UPDATE document_series
           SET curr = curr + 1
         WHERE session_id = $1 AND doc_type = $2 AND year = $3`,
        [sid, t, fy]
      );

      // 2) read back prefix/year/curr
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

      // 3) build number string and attempt reservation
      const number = `${prefix}-${year}-${String(curr).padStart(5, "0")}`;

      // Prefer PG syntax; fall back to SQLite "INSERT OR IGNORE"
      try {
        const ins = await query(
          `INSERT INTO series_reservations
             (reservation_id, session_id, doc_type, fy, number, preview_id, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'HELD', $7)
           ON CONFLICT DO NOTHING`,
          [reservationId, sid, t, fy, number, previewId, expiresAt]
        );
        const count = (ins && (ins.rowCount ?? ins.changes)) || 0;
        if (count > 0) {
          return { ok: true, number };
        }
      } catch (e) {
        // SQLite path or older PG — try INSERT OR IGNORE
        const ins2 = await query(
          `INSERT OR IGNORE INTO series_reservations
             (reservation_id, session_id, doc_type, fy, number, preview_id, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'HELD', $7)`,
          [reservationId, sid, t, fy, number, previewId, expiresAt]
        );
        const count2 = (ins2 && (ins2.rowCount ?? ins2.changes)) || 0;
        if (count2 > 0) {
          return { ok: true, number };
        }
        // If still not inserted, treat as conflict and retry
      }

      return { ok: false };
    });

    if (inserted.ok) {
      return {
        reservationId,
        number: inserted.number,
        expiresAt,
        sessionId: sid,
      };
    }
    // else: conflict — loop and try next candidate
  }

  const err = new Error("reserveSeries: failed to reserve a document number after multiple attempts");
  err.http = 503;
  throw err;
}

/**
 * Mark a reservation as USED.
 * Accepts either (reservationId, sessionId?) or ({ reservationId, sessionId }).
 */
export async function finalizeReservation(a, b) {
  const reservationId = (typeof a === "object" && a !== null) ? a.reservationId : a;
  const sessionId = (typeof a === "object" && a !== null) ? a.sessionId : b;

  if (!reservationId) return;

  if (sessionId) {
    await query(
      `UPDATE series_reservations SET status = 'USED'
        WHERE reservation_id = $1 AND session_id = $2`,
      [reservationId, sessionId]
    );
  } else {
    await query(
      `UPDATE series_reservations SET status = 'USED'
        WHERE reservation_id = $1`,
      [reservationId]
    );
  }
}

/**
 * Cancel a reservation (mark EXPIRED). sessionId is optional.
 */
export async function cancelReservation(a, b) {
  const reservationId = (typeof a === "object" && a !== null) ? a.reservationId : a;
  const sessionId = (typeof a === "object" && a !== null) ? a.sessionId : b;

  if (!reservationId) return;

  if (sessionId) {
    await query(
      `UPDATE series_reservations SET status = 'EXPIRED'
        WHERE reservation_id = $1 AND session_id = $2`,
      [reservationId, sessionId]
    );
  } else {
    await query(
      `UPDATE series_reservations SET status = 'EXPIRED'
        WHERE reservation_id = $1`,
      [reservationId]
    );
  }
}

/**
 * Housekeeping to expire stale HELD reservations.
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
 * Convenience: immediately get a number (short hold).
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
