import { hasDuplicateInvoice } from "../../repo.js";
import { err } from "../../result.js";
import { CODES } from "../../codes.js";

export default async function duplicateInvoiceRule(ctx){
  if (ctx.docType!=="invoice") return {errors:[],warnings:[],info:[]};
  const dm = ctx.docModel || {};
  const payload = { party: dm.party||dm.customer||"", number: dm.number||"", date: dm.date||"", gross: dm.total||0 };
  if (!payload.number || !payload.date) return {errors:[],warnings:[],info:[]};
  const dup = await hasDuplicateInvoice(payload);
  return dup ? {errors:[err(CODES.DUPLICATE_DOC,"Invoice number already exists for the date",payload)],warnings:[],info:[]} : {errors:[],warnings:[],info:[]};
}
