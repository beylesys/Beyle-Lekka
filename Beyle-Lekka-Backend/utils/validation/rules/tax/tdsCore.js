import { err } from "../../result.js";
import { computeTDS } from "../../../tax/tdsUtil.js";
import { round2 } from "../../../tax/gstUtil.js";
import { CODES } from "../../codes.js";

export default async function tdsCoreRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  if (!ctx.policy?.tds?.enabled) return res;

  const dm = ctx.docModel || {};
  const applies = (ctx.docType==="payment_voucher") || (dm.tds?.apply===true);
  if (!applies) return res;

  const section = dm.tds?.section || "";
  if (!section) { res.errors.push(err(CODES.TDS_SECTION_MISSING,"TDS section is required when TDS applies")); return res; }

  const taxable = Number(dm.taxable || dm.subtotal || 0);
  const gross   = Number(dm.total || 0);
  const panAvailable = dm.tds?.panAvailable !== false;
  const { base, rate, tds: expected } = computeTDS({ section, policy: ctx.policy, taxable, gross, panAvailable });
  const shown = round2(Number(dm.tds?.amount || 0));
  if (shown!==expected) res.errors.push(err(CODES.TDS_MISMATCH,`TDS mismatch: computed ${expected} vs shown ${shown}`,{section,base,rate,expected,shown}));

  const reqLed = (ctx.policy?.tds?.requireLedger || "TDS Payable").toLowerCase();
  const hasLed = (ctx.journal||[]).some(l => String(l.account||"").toLowerCase()===reqLed);
  if (!hasLed) res.errors.push(err(CODES.TDS_LEDGER_MISSING,`Required TDS ledger not found in entry: ${reqLed}`));
  return res;
}
