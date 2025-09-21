import { getLedger } from "../../repo.js";
import { CODES } from "../../codes.js";
import { err } from "../../result.js";

export default async function ledgerTypesRule(ctx){
  const out = { errors:[], warnings:[], info:[] };
  for (let i=0;i<(ctx.journal||[]).length;i++){
    const acc = ctx.journal[i]?.account;
    const led = await getLedger(acc);
    if (!led || led.is_active===0) out.errors.push(err(CODES.LEDGER_MISSING,`Ledger not found or inactive: ${acc}`,{index:i,account:acc}));
  }
  return out;
}
