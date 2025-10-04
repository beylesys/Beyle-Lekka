// utils/preview/fundsHolds.js
import { randomUUID } from "crypto";
import { query } from "../../services/db.js";

const toCents = (n) => Math.round((Number(n) || 0) * 100);

export async function createFundsHolds({ sessionId, journal, defaultDate, previewId }) {
  if (!Array.isArray(journal) || !journal.length) return 0;
  const map = new Map(); // key=account|date -> cents
  for (const l of journal) {
    const drC = toCents(l?.debit || 0);
    const crC = toCents(l?.credit || 0);
    if (crC <= drC) continue; // only outflows
    const date = String(l?.date || defaultDate || new Date().toISOString().slice(0,10));
    const key = `${String(l?.account||"")}|${date}`;
    map.set(key, (map.get(key)||0) + (crC - drC));
  }
  let created = 0;
  for (const [key, cents] of map) {
    if (cents <= 0) continue;
    const [account, d] = key.split("|");
    await query(
      `INSERT INTO funds_holds (id, session_id, account, hold_date, amount_cents, preview_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, datetime('now','+30 minutes'))`,
      [randomUUID(), sessionId, account, d, cents, previewId]
    );
    created++;
  }
  return created;
}

export async function releaseFundsHolds({ sessionId, previewId }) {
  await query(
    `DELETE FROM funds_holds WHERE preview_id = $1 AND ($2 IS NULL OR session_id = $2)`,
    [previewId, sessionId]
  );
}
