import invoicePack from "./packs/invoice.js";
import receiptPack from "./packs/receipt.js";
import paymentVoucherPack from "./packs/paymentVoucher.js";
import journalPack from "./packs/journal.js";
import defPolicy from "./policies/default.json" with { type: "json" };
import { emptyResult, combine } from "./result.js";

const packsByType = { invoice:invoicePack, receipt:receiptPack, payment_voucher:paymentVoucherPack, journal:journalPack };

export async function runValidation(ctxIn){
  const policy = { ...defPolicy, ...(ctxIn.policy||{}) };
  const ctx = { ...ctxIn, policy, tz: ctxIn.tz || policy.timezone || "Asia/Kolkata", mode: ctxIn.mode || "preview" };
  const pack = packsByType[ctx.docType] || journalPack;
  let acc = emptyResult();
  for (const rule of pack){ acc = combine(acc, await rule(ctx)); }
  return acc;
}
