import { CODES } from "../../codes.js";
import { err } from "../../result.js";

export default async function schemaRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  const j = Array.isArray(ctx.journal) ? ctx.journal : [];
  if (j.length < 2) {
    res.errors.push(err(CODES.SHAPE_MIN_LINES,"Journal must have at least two lines"));
    return res;
  }
  for (let i=0;i<j.length;i++){
    const l=j[i]||{};
    const hasDr = Number(l.debit||0) > 0;
    const hasCr = Number(l.credit||0) > 0;
    if (hasDr && hasCr) res.errors.push(err(CODES.DRCR_EXCLUSIVE,"Line cannot have both debit and credit",{index:i}));
  }
  return res;
}
