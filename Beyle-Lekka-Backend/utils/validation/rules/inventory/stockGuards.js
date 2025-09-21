import { getOnHand } from "../../repo.js";
import { err, warn } from "../../result.js";
import { CODES } from "../../codes.js";

export default async function stockGuardsRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  if (!ctx.policy?.inventory?.enabled) return res;

  const items = Array.isArray(ctx.docModel?.items) ? ctx.docModel.items : [];
  for (let i=0;i<items.length;i++){
    const it = items[i] || {};
    const track = it.stockTracked===true || it.stock_tracked===true;
    if (!track) continue;
    const code = it.code || it.itemCode || it.sku;
    const qty  = Number(it.qty || 0);
    if (!code || qty<=0) continue;

    const on = await getOnHand(code);
    if (!on) { res.errors.push(err(CODES.INV_ITEM_MISSING,`Item not found: ${code}`,{index:i,code})); continue; }
    const onhand = Number(on.onhand||0);
    if (onhand < qty){
      if (ctx.policy?.inventory?.blockNegativeStock) res.errors.push(err(CODES.INV_NEG_STOCK,`Insufficient stock for ${code}: on-hand ${onhand}, requested ${qty}`,{index:i,code,onhand,qty}));
      else res.warnings.push(warn(CODES.INV_NEG_STOCK_WARN,`Stock would go negative for ${code}`,{index:i,code,onhand,qty}));
    }
  }
  return res;
}
