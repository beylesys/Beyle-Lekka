import { randomUUID } from "crypto";
import { query } from "../../services/db.js";
import { stableHash } from "./hash.js";

export async function createSnapshot({ docType, payload, reservation, sessionId, userId }){
  const previewId = randomUUID();
  const hash = stableHash(payload);
  await query(
    `INSERT INTO preview_snapshots (preview_id, doc_type, payload_json, hash, reservation_id, reserved_number, expires_at, created_by, session_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE')`,
    [previewId, docType, JSON.stringify(payload), hash, reservation.reservationId, reservation.number, reservation.expiresAt, userId||null, sessionId||null]
  );
  return { previewId, hash, expiresAt: reservation.expiresAt };
}

export async function getSnapshot(previewId){
  const { rows } = await query("SELECT * FROM preview_snapshots WHERE preview_id=$1",[previewId]);
  if (!rows.length) return null;
  const r = rows[0];
  return { ...r, payload: JSON.parse(r.payload_json) };
}

export async function markUsed(previewId){
  await query("UPDATE preview_snapshots SET status='USED' WHERE preview_id=$1",[previewId]);
}
