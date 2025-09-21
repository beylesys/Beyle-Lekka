import { query } from "./db.js";
import { randomUUID } from "crypto";

function fyFromDate(dISO){ return Number(dISO?.slice(0,4) || new Date().getFullYear()); }
function mapType(t){ return t==="payment_voucher" ? "voucher" : t; }

export async function ensureSeriesRow(docType){
  const t = mapType(docType);
  await query(`CREATE TABLE IF NOT EXISTS document_series (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL, year INTEGER NOT NULL, curr INTEGER NOT NULL)`);
  const { rows } = await query("SELECT 1 FROM document_series WHERE doc_type=$1",[t]);
  if(!rows.length){
    const prefix = (t==="invoice"?"INV":t==="receipt"?"RCT":"PV");
    await query("INSERT INTO document_series (doc_type,prefix,year,curr) VALUES ($1,$2,$3,$4)",[t,prefix,fyFromDate(),0]);
  }
}

export async function reserveSeries({ docType, dateISO, previewId, ttlSec=1800 }){
  const t = mapType(docType), fy=fyFromDate(dateISO), now=new Date();
  const expires = new Date(now.getTime()+ttlSec*1000).toISOString();
  const reservationId = randomUUID();
  await ensureSeriesRow(t);
  await query("UPDATE document_series SET curr=curr+1, year=$2 WHERE doc_type=$1",[t,fy]);
  const r = await query("SELECT prefix,year,curr FROM document_series WHERE doc_type=$1",[t]);
  const { prefix, year, curr } = r.rows[0];
  const number = `${prefix}-${year}-${String(curr).padStart(5,"0")}`;
  await query(`INSERT INTO series_reservations (reservation_id, doc_type, fy, number, preview_id, status, expires_at)
               VALUES ($1,$2,$3,$4,$5,'HELD',$6)`,[reservationId,t,fy,number,previewId,expires]);
  return { reservationId, number, expiresAt: expires };
}

export async function finalizeReservation(reservationId){
  await query("UPDATE series_reservations SET status='USED' WHERE reservation_id=$1",[reservationId]);
}

// Optional legacy helper
export async function getNextNumber(docType, dateISO){
  const { number } = await reserveSeries({ docType, dateISO, previewId: randomUUID(), ttlSec:1 });
  return number;
}
