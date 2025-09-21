// utils/stock/wavg.js
import { query } from "../../services/db.js";

/**
 * Maintain per-item weighted average (simple implementation).
 * We keep no separate table; compute WAVG on the fly up to date, or cache later.
 */

export async function getWAVG(item_id, asOfDate = "2999-12-31", warehouse_id = null) {
  const { rows } = await query(
    `SELECT SUM(qty_in) AS qty_in, SUM(qty_out) AS qty_out, SUM(value_cents) AS value_cents
       FROM stock_ledger
      WHERE item_id=$1 AND date <= $2
        AND ($3 IS NULL OR warehouse_id=$3)`,
    [item_id, asOfDate, warehouse_id]
  );
  const r = rows[0] || {};
  const qty = (r.qty_in || 0) - (r.qty_out || 0);
  const val = r.value_cents || 0;
  const rate = qty > 0 ? Math.round(val / qty) : 0;
  return { qty, rate_cents: rate };
}

/**
 * Post a stock movement; set value_cents based on WAVG for issues and purchase rate for receipts.
 * movement: { id, date, item_id, qty_in, qty_out, warehouse_id, rate_cents? }
 */
export async function postMovement(mv) {
  const isIssue = (mv.qty_out || 0) > 0;
  let rate_cents = mv.rate_cents || 0;
  if (isIssue && !rate_cents) {
    const { rate_cents: r } = await getWAVG(mv.item_id, mv.date, mv.warehouse_id || null);
    rate_cents = r;
  }
  const value_cents =
    Math.round((mv.qty_in || 0) * (mv.rate_cents || 0)) +
    Math.round((mv.qty_out || 0) * rate_cents);

  await query(
    `INSERT INTO stock_ledger (id, date, item_id, qty_in, qty_out, ref_doc, warehouse_id, rate_cents, value_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [mv.id, mv.date, mv.item_id, mv.qty_in||0, mv.qty_out||0, mv.ref_doc||null, mv.warehouse_id||null, rate_cents||0, value_cents||0]
  );

  return { rate_cents, value_cents };
}
