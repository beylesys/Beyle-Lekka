import { CODES } from "../../codes.js";
import { err } from "../../result.js";
const looksBankOrCash = (n="") => (n+"").toLowerCase().includes("bank") || (n+"").toLowerCase().includes("cash");

export default async function bankCashRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  const j = ctx.journal || [];
  const bankLines = j.filter(l => looksBankOrCash(l.account));
  if (bankLines.length===0) return res;
  if (j.length===1) res.errors.push(err(CODES.BANK_SINGLELINE,"Single-line bank/cash entries are not allowed"));
  const uniq = Array.from(new Set(bankLines.map(l=>String(l.account))));
  if (uniq.length>1) res.errors.push(err(CODES.BANK_MIXED,"Multiple bank/cash ledgers in one entry are not allowed",{ledgers:uniq}));
  return res;
}
