import { CODES } from "../../codes.js";
import { err } from "../../result.js";
const r2 = n => Math.round(Number(n||0)*100)/100;

export default async function balanceRule(ctx){
  let dr=0, cr=0;
  for (const l of (ctx.journal||[])){ dr += Number(l.debit||0); cr += Number(l.credit||0); }
  return r2(dr)===r2(cr) ? {errors:[],warnings:[],info:[]} :
    {errors:[err(CODES.NOT_BALANCED,`Debits (${dr}) do not equal credits (${cr})`)],warnings:[],info:[]};
}
