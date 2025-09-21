// utils/deterministicEnforce.js
// Deterministic, production-safe fix-ups applied AFTER model inference.
// Ensures: payment channel -> correct credit ledger; GST input split from fields;
//          errand/retail slips default to Office Expenses (not Purchases).

// Local helpers
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// COA ledger names as seeded in utils/coaService.js
const LEDGERS = {
  bank: "Bank",
  cash: "Cash",
  inputIGST: "GST Input (IGST)",
  inputCGST: "GST Input (CGST)",
  inputSGST: "GST Input (SGST)",
  expenseDefault: "Office Expenses",
  roundOffCr: "Round-off (Income)",
  roundOffDr: "Round-off (Expense)"
};

function normalizeMode(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim|paytm|qr)/i.test(s)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(s)) return "BANK";
  if (/(card|visa|master|rupay|debit|credit)/i.test(s)) return "CARD";
  if (/cash/i.test(s)) return "CASH";
  return null;
}

function enforceCreditFromMode(journal, fields) {
  const mode = normalizeMode(fields?.payment_mode || fields?.mode || (fields?.paid ? "BANK" : null));
  if (!mode) return journal;
  const crLine = (journal || []).find(l => Number(l?.credit || 0) > 0);
  if (!crLine) return journal;
  crLine.account = (mode === "CASH") ? LEDGERS.cash : LEDGERS.bank;
  return journal;
}

function ensureGstSplit(journal, fields, opts = { assumeIntra: true, preferExpense: true, text: "" }) {
  const subtotal = Number(fields?.subtotal_amount ?? fields?.subtotal);
  const taxes    = Number(fields?.tax_amount ?? fields?.taxes);
  const total    = Number(fields?.total_amount ?? fields?.total);
  if (![subtotal, taxes, total].every(Number.isFinite)) return journal;
  if (R2(subtotal + taxes) !== R2(total)) return journal;

  const hasGSTInput = (journal || []).some(l => /GST Input/i.test(String(l?.account || "")));
  if (hasGSTInput) return journal;

  // Identify the main debit (non-tax, non-credit) line
  const credits = (journal || []).filter(l => Number(l?.credit || 0) > 0);
  const debits  = (journal || []).filter(l => Number(l?.debit  || 0) > 0);
  const credit  = credits[0] || { account: LEDGERS.bank, credit: R2(total) };
  let   mainDr  = debits.find(l => !/GST|Tax/i.test(String(l?.account || ""))) || debits[0];

  // Convert retail/errand cues to Office Expenses (not Purchases)
  const vendorName = String(fields?.vendor_name || fields?.supplier_name || "").toLowerCase();
  const rawText    = String(opts?.text || "").toLowerCase();
  const expenseCue = /(super\s*market|store|mart|hotel|restaurant|canteen|grocery|kirana|medical|pharmacy|cab|uber|ola|electric|power|internet|broadband|telecom|mobile|fuel|petrol|diesel|stationery|office\s*supply)/i;
  const looksErrand = expenseCue.test(vendorName) || expenseCue.test(rawText);

  if (!mainDr) mainDr = { account: LEDGERS.expenseDefault, debit: R2(subtotal + taxes) };
  if (opts?.preferExpense && looksErrand) {
    mainDr.account = LEDGERS.expenseDefault;
  }

  const cgst = opts?.assumeIntra ? R2(taxes / 2) : 0;
  const sgst = opts?.assumeIntra ? R2(taxes - cgst) : 0;
  const igst = opts?.assumeIntra ? 0 : R2(taxes);

  const out = [
    { account: mainDr.account || LEDGERS.expenseDefault, debit: R2(subtotal), credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" }
  ];
  if (igst) {
    out.push({ account: LEDGERS.inputIGST, debit: igst, credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" });
  } else {
    out.push({ account: LEDGERS.inputCGST, debit: cgst, credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" });
    out.push({ account: LEDGERS.inputSGST, debit: sgst, credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" });
  }
  out.push({ account: credit?.account || LEDGERS.bank, debit: 0, credit: R2(total), date: credit?.date || mainDr?.date, narration: credit?.narration || "" });

  return out;
}

function addRoundOff(journal) {
  const dr = (journal || []).reduce((s,l)=>s + (Number(l?.debit)||0), 0);
  const cr = (journal || []).reduce((s,l)=>s + (Number(l?.credit)||0), 0);
  const delta = R2(dr - cr);
  if (Math.abs(delta) > 0 && Math.abs(delta) <= 0.05) {
    if (delta > 0) journal.push({ account: LEDGERS.roundOffCr, debit: 0, credit: Math.abs(delta) });
    else journal.push({ account: LEDGERS.roundOffDr, debit: Math.abs(delta), credit: 0 });
  }
  return journal;
}

export function enforceAll(journalIn, fields, docTypeHint, rawText) {
  let j = Array.isArray(journalIn) ? journalIn.map(l => ({...l})) : [];
  j = ensureGstSplit(j, fields, { assumeIntra: true, preferExpense: true, text: rawText });
  j = enforceCreditFromMode(j, fields);
  j = addRoundOff(j);
  return j;
}
