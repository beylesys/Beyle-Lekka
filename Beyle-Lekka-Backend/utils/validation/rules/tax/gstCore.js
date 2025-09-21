import { CODES } from "../../codes.js";
import { err } from "../../result.js";
import { isValidGSTIN, stateCodeFromGSTIN, isInterState, computeGSTBreakup, round2 } from "../../../tax/gstUtil.js";

export default async function gstCoreRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  if (!ctx.policy?.gst?.enabled) return res;
  if (ctx.docType!=="invoice") return res;

  const dm = ctx.docModel || {};
  const supplier = dm.supplierGSTIN || dm.sellerGSTIN || dm.fromGSTIN || "";
  const customer = dm.customerGSTIN || dm.buyerGSTIN || dm.toGSTIN || "";
  const posCode  = dm.placeOfSupplyCode || dm.placeOfSupply || stateCodeFromGSTIN(customer) || null;
  const origin   = stateCodeFromGSTIN(supplier);
  const inter    = isInterState(origin, posCode, !(ctx.policy?.gst?.assumeIntraIfUnknown));

  if (supplier && !isValidGSTIN(supplier)) res.errors.push(err(CODES.GST_SUPPLIER_INVALID,"Supplier GSTIN invalid",{supplier}));
  if (customer && !isValidGSTIN(customer)) res.errors.push(err(CODES.GST_CUSTOMER_INVALID,"Customer GSTIN invalid",{customer}));

  const items = Array.isArray(dm.items)?dm.items:[];
  const calc  = computeGSTBreakup(items, inter);

  const shownIGST = round2(dm.igst || dm.tax_igst || 0);
  const shownCGST = round2(dm.cgst || dm.tax_cgst || 0);
  const shownSGST = round2(dm.sgst || dm.tax_sgst || 0);
  const shownTax  = round2(dm.taxes || dm.tax || shownIGST + shownCGST + shownSGST);
  const shownGross= round2(dm.total || 0);

  if (inter && (shownCGST || shownSGST)) res.errors.push(err(CODES.GST_SPLIT_INTER,"Inter-state supply must use IGST only",{shownIGST,shownCGST,shownSGST}));
  if (!inter && shownIGST) res.errors.push(err(CODES.GST_SPLIT_INTRA,"Intra-state supply must split as CGST+SGST",{shownIGST,shownCGST,shownSGST}));

  if (round2(calc.totalTax)!==shownTax) res.errors.push(err(CODES.GST_TAX_MISMATCH,`GST mismatch: computed ${calc.totalTax} vs shown ${shownTax}`,{computed:calc,shown:{shownIGST,shownCGST,shownSGST,shownTax}}));
  if (shownGross && round2(calc.gross)!==shownGross) res.errors.push(err(CODES.GST_GROSS_MISMATCH,`Gross mismatch: computed ${calc.gross} vs shown ${shownGross}`,{computed:calc.gross,shown:shownGross}));

  return res;
}
