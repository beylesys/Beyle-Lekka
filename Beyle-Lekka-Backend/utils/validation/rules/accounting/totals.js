import { CODES } from "../../codes.js";
import { err } from "../../result.js";
const r2=n=>Math.round(Number(n||0)*100)/100;

export default async function totalsRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  const dm = ctx.docModel || {};
  const items = Array.isArray(dm.items) ? dm.items : [];
  let sum=0; for (const it of items){ const qty=Number(it.qty||1), rate=Number(it.rate||it.price||0); const amt=(it.amount!=null)?Number(it.amount):qty*rate; sum+=amt; }
  const taxes = Number(dm.taxes || dm.tax || 0);
  const computed = r2(sum + taxes);
  const shown = r2(Number(dm.total || computed));
  if (shown!==computed) res.errors.push(err(CODES.TOTALS_MISMATCH,`Totals mismatch: computed ${computed} vs shown ${shown}`,{computed,shown}));
  return res;
}
