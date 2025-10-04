// controllers/orchestrateController.js

import crypto from "crypto";
import { inferJournalEntriesFromPrompt } from "../utils/mergedInferAccountingFromPrompt.js";
import { classifyPromptType, buildCanonicalPromptFromSignals } from "../utils/classifyPromptType.js";
import { buildLedgerView } from "../utils/jeCore.js";
import { runValidation } from "../utils/validation/index.js";
import { reserveSeries } from "../services/series.js";
import { createSnapshot } from "../utils/preview/snapshotStore.js";

// Default spending account + preview holds + COA auto-create
import { getDefaultSpendingAccount } from "../services/workspaceSettings.js";
import { ensureLedgerExists } from "../utils/coaService.js";
import { createFundsHolds } from "../utils/preview/fundsHolds.js";

/* =======================================================================
   Deterministic helpers
   ======================================================================= */
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const LEDGERS = {
  bank: "Bank",
  cash: "Cash",
  inputIGST: "GST Input (IGST)",
  inputCGST: "GST Input (CGST)",
  inputSGST: "GST Input (SGST)",
  expenseDefault: "Office Expenses",
  roundOffCr: "Round-off (Income)",
  roundOffDr: "Round-off (Expense)",
};

function normalizePayMode(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim|paytm|qr)/i.test(s)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(s)) return "BANK";
  if (/(card|visa|master|rupay|debit|credit)/i.test(s)) return "CARD";
  if (/\bcash\b/i.test(s)) return "CASH";
  if (/(cheque|check|chq)/i.test(s)) return "CHEQUE";
  return null;
}
function detectModeFromText(rawText) {
  const s = String(rawText || "").toLowerCase();
  if (!s) return null;
  if (/\bcash\b/.test(s)) return "CASH";
  if (/(upi|gpay|google\s*pay|phonepe|bhim|paytm|qr)/i.test(s)) return "UPI";
  if (/(neft|imps|rtgs|bank\s*transfer|online\s*transfer)/i.test(s)) return "BANK";
  if (/(card|visa|master|rupay|debit|credit)/i.test(s)) return "CARD";
  if (/(cheque|check|chq)/i.test(s)) return "CHEQUE";
  return null;
}

// Modes that imply a bank account (we can safely default to the workspace bank if not named)
const BANK_LIKE = new Set(["BANK", "UPI", "CARD", "CHEQUE"]);

// Return an explicit mode only if it is stated in fields or raw text; do NOT guess.
function explicitModeFromSignals(fields, rawText) {
  const fieldMode = normalizePayMode(fields?.payment_mode || fields?.mode);
  const textMode = detectModeFromText(rawText);
  return fieldMode || textMode || null;
}

// Do not override obviously non-instrument credits (capital, sales, creditors, tax, loans)
function enforceCreditFromMode(journal, fields, rawTextForCues = "") {
  const fieldMode = normalizePayMode(fields?.payment_mode || fields?.mode);
  const textMode  = detectModeFromText(rawTextForCues);
  const mode = fieldMode || textMode;
  if (!mode) return journal;

  const j = Array.isArray(journal) ? journal.map(l => ({ ...l })) : [];
  const crLine = j.find(l => Number(l?.credit || 0) > 0);
  if (!crLine) return j;

  const name = String(crLine.account || "");
  const looksNonInstrument =
    /capital|share|equity|sales|revenue|output\s*gst|gst\s*payable|creditors?|accounts\s*payable|loan|tds|duties|tax/i.test(name);
  if (looksNonInstrument) return j;

  crLine.account = (mode === "CASH") ? LEDGERS.cash : LEDGERS.bank;
  return j;
}

function ensureGstSplit(journal, fields, opts = { assumeIntra: true, preferExpense: true, text: "" }) {
  const subtotal = Number(fields?.subtotal_amount ?? fields?.subtotal);
  const taxes    = Number(fields?.tax_amount ?? fields?.taxes);
  const total    = Number(fields?.total_amount ?? fields?.total);
  if (![subtotal, taxes, total].every(Number.isFinite)) return journal;
  if (R2(subtotal + taxes) !== R2(total)) return journal;

  const hasGSTInput = (journal || []).some(l => /GST Input/i.test(String(l?.account || "")));
  if (hasGSTInput) return journal;

  const credits = (journal || []).filter(l => Number(l?.credit || 0) > 0);
  const debits  = (journal || []).filter(l => Number(l?.debit  || 0) > 0);
  const credit  = credits[0] || { account: LEDGERS.bank, credit: R2(total) };
  let   mainDr  = debits.find(l => !/GST|Tax/i.test(String(l?.account || ""))) || debits[0];

  const vendorName = String(fields?.vendor_name || fields?.supplier_name || "").toLowerCase();
  const rawText    = String(opts?.text || "").toLowerCase();
  const expenseCue = /(super\s*market|store|mart|hotel|restaurant|canteen|grocery|kirana|medical|pharmacy|cab|uber|ola|electric|power|internet|broadband|telecom|mobile|fuel|petrol|diesel|stationery|office\s*supply)/i;
  const looksErrand = expenseCue.test(vendorName) || expenseCue.test(rawText);

  if (!mainDr) mainDr = { account: LEDGERS.expenseDefault, debit: R2(subtotal + taxes) };
  if (opts?.preferExpense && looksErrand) mainDr.account = LEDGERS.expenseDefault;

  const cgst = opts?.assumeIntra ? R2(taxes / 2) : 0;
  const sgst = opts?.assumeIntra ? R2(taxes - cgst) : 0;
  const igst = opts?.assumeIntra ? 0 : R2(taxes);

  const out = [{ account: mainDr.account || LEDGERS.expenseDefault, debit: R2(subtotal), credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" }];
  if (igst) out.push({ account: LEDGERS.inputIGST, debit: igst, credit: 0, date: mainDr?.date, narration: mainDr?.narration || "" });
  else {
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

function enforceAll(journalIn, fields, rawTextForCues = "") {
  let j = Array.isArray(journalIn) ? journalIn.map(l => ({...l})) : [];
  j = ensureGstSplit(j, fields, { assumeIntra: true, preferExpense: true, text: rawTextForCues });
  j = enforceCreditFromMode(j, fields, rawTextForCues); // safe, non-intrusive
  j = addRoundOff(j);
  return j;
}

/* ========================= Instrument placement (directional + contra) ========================= */
const INSTRUMENT_RE = /(cash|bank|overdraft|o\.?d\.?|occ|o\.?c\.?c\.?|cash\s*credit|current\s*account|loan)/i;
const looksInstrument = (s) => INSTRUMENT_RE.test(String(s || ""));
const hasInstrumentLine = (journal) => (journal || []).some(l => looksInstrument(l?.account));
const isExactCash = (name) => /^cash$/i.test(String(name || "").trim());

// --- Contra detection ---
function detectContraIntent(rawText) {
  const s = String(rawText || "").toLowerCase();
  if (/(withdraw|withdrew|drawn)\s+cash|cash\s*withdrawal|petty\s*cash/i.test(s)) return "BANK_TO_CASH";
  if (/(deposit|deposited)\s+cash|cash\s+deposit|cash\s+to\s+bank/i.test(s)) return "CASH_TO_BANK";
  if (/transfer\s+(to|from)\s+(bank|cash)/i.test(s)) return "TRANSFER";
  return "NONE";
}
async function resolveBankInstrumentForContra(sessionId) {
  try {
    const def = await getDefaultSpendingAccount(sessionId);
    if (!def || isExactCash(def)) return LEDGERS.bank;
    return def;
  } catch {
    return LEDGERS.bank;
  }
}
function rewriteLargestSides(journal, debitAccount, creditAccount) {
  const j = Array.isArray(journal) ? journal.map(r => ({ ...r })) : [];
  if (!j.length) return j;
  let di = -1, dmax = -1, ci = -1, cmax = -1;
  j.forEach((l, i) => {
    const d = Number(l?.debit || 0);
    const c = Number(l?.credit || 0);
    if (d > dmax) { dmax = d; di = i; }
    if (c > cmax) { cmax = c; ci = i; }
  });
  if (di >= 0 && debitAccount)  j[di].account = debitAccount;
  if (ci >= 0 && creditAccount) j[ci].account = creditAccount;
  return j;
}
async function applyContraIfDetected(journal, sessionId, rawText) {
  const intent = detectContraIntent(rawText);
  if (intent === "NONE") return { journal, applied: false };
  const bankAcct = await resolveBankInstrumentForContra(sessionId);

  if (intent === "BANK_TO_CASH") {
    const j = rewriteLargestSides(journal, LEDGERS.cash, bankAcct);
    return { journal: j, applied: true };
  }
  if (intent === "CASH_TO_BANK") {
    const j = rewriteLargestSides(journal, bankAcct, LEDGERS.cash);
    return { journal: j, applied: true };
  }
  if (intent === "TRANSFER") {
    // Best-effort: if "cash" mentioned it means bank↔cash; otherwise skip (we don't support bank↔bank here)
    const hasCash = /\bcash\b/i.test(String(rawText || ""));
    if (!hasCash) return { journal, applied: false };
    const j = rewriteLargestSides(journal, bankAcct, LEDGERS.cash);
    return { journal: j, applied: true };
  }
  return { journal, applied: false };
}

// For non-contra: payments → Cr instrument; receipts → Dr instrument.
// NOTE: Only acts when a mode is EXPLICIT (fields or text). Otherwise leaves the journal untouched.
async function applyDefaultSpendingAccount(
  journal,
  fields,
  sessionId,
  rawTextForCues = "",
  intentHint = null
) {
  const j = Array.isArray(journal) ? journal.map(r => ({ ...r })) : [];
  if (!j.length) return j;

  const mode = explicitModeFromSignals(fields, rawTextForCues);
  if (!mode) return j; // Ask-first policy: do nothing unless explicit

  // Resolve desired instrument ledger
  let acct = LEDGERS.bank;
  if (mode === "CASH") {
    acct = LEDGERS.cash;
  } else if (BANK_LIKE.has(mode)) {
    try {
      const def = await getDefaultSpendingAccount(sessionId);
      acct = (def && !isExactCash(def)) ? def : LEDGERS.bank;
    } catch {
      acct = LEDGERS.bank;
    }
  }

  // Only operate for payment/receipt documents
  if (intentHint === "payment_voucher") {
    let ci = -1, cmax = -1;
    j.forEach((l, i) => { const c = Number(l?.credit || 0); if (c > cmax) { cmax = c; ci = i; } });
    if (ci >= 0) j[ci].account = acct; // override ANY guessed instrument
  } else if (intentHint === "receipt") {
    let di = -1, dmax = -1;
    j.forEach((l, i) => { const d = Number(l?.debit || 0); if (d > dmax) { dmax = d; di = i; } });
    if (di >= 0) j[di].account = acct;
  }

  return j;
}

/* ========================= Contra helpers (minimal) ========================= */
function isContraJournalShape(journal) {
  const rows = Array.isArray(journal) ? journal : [];
  const instr = rows.filter(l => looksInstrument(l?.account));
  const others = rows.filter(l => !looksInstrument(l?.account));
  if (others.length > 0) return false;
  if (instr.length !== 2) return false;
  const dr = instr.reduce((s,l)=>s + Number(l?.debit || 0), 0);
  const cr = instr.reduce((s,l)=>s + Number(l?.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.005) return false;
  const s1 = Number(instr[0]?.debit||0) > 0 ? "DR" : (Number(instr[0]?.credit||0) > 0 ? "CR" : "");
  const s2 = Number(instr[1]?.debit||0) > 0 ? "DR" : (Number(instr[1]?.credit||0) > 0 ? "CR" : "");
  return (s1 && s2 && s1 !== s2);
}
function buildContraDocumentFields(journal, existing = {}) {
  const rows = Array.isArray(journal) ? journal : [];
  const date = rows[0]?.date || new Date().toISOString().slice(0, 10);
  const totalDr = rows.reduce((s, l) => s + Number(l?.debit || 0), 0);
  const totalCr = rows.reduce((s, l) => s + Number(l?.credit || 0), 0);
  const amount = R2(Math.max(totalDr, totalCr));
  // Direction: if Cash gets DR, it's BANK_TO_CASH; if Cash gets CR, it's CASH_TO_BANK.
  const cashDr = rows.some(l => /^cash$/i.test(String(l?.account || "")) && Number(l?.debit || 0) > 0);
  const direction = cashDr ? "BANK_TO_CASH" : "CASH_TO_BANK";
  const prior = (existing && typeof existing === "object") ? (existing.contra_voucher || {}) : {};
  return { contra_voucher: { ...prior, date, amount, direction } };
}
function isPayeeClarification(s) {
  const t = String(s || "").toLowerCase();
  return /\b(payee|to whom|beneficiary|vendor|party|supplier|recipient)\b/.test(t);
}

/* ========================= Purchase/receipt coercions ========================= */
function coerceDocTypeForPurchase(docType, documentFields, journal, promptStr = "") {
  const j = Array.isArray(journal) ? journal : [];
  const hasSalesOut =
    j.some(l => /sales|revenue|output\s*gst|gst\s*payable/i.test(String(l?.account||"")) && Number(l?.credit||0) > 0);
  const hasGstInputDr =
    j.some(l => /input\s*(igst|cgst|sgst)|gst\s*input/i.test(String(l?.account||"")) && Number(l?.debit||0) > 0);
  const hasAssetOrExpenseDr =
    j.some(l => Number(l?.debit||0) > 0 && !/sales|revenue|output\s*gst|gst\s*payable/i.test(String(l?.account||"")));
  const looksPurchase = !hasSalesOut && (hasGstInputDr || hasAssetOrExpenseDr);
  const hasBankCr = j.some(l => /bank/i.test(String(l?.account||"")) && Number(l?.credit||0) > 0);
  const hasCashCr = j.some(l => /^cash$/i.test(String(l?.account||"")) && Number(l?.credit||0) > 0);

  if (docType !== "invoice" || !looksPurchase || (!hasBankCr && !hasCashCr)) return { docType, documentFields };

  const vendorFromJournal =
    j.find(l => /(creditors|accounts payable|supplier|vendor|distribut(e|o)rs?)/i.test(String(l?.account||"")) && Number(l?.credit||0) > 0)
      ?.account?.replace(/^(creditors|accounts payable)\s*-\s*/i, "")?.trim();
  const vendorFromPrompt = (promptStr.match(/from\s+([^,]+?)(?:\s|$|,)/i)?.[1] || "").trim();
  const vendorName = vendorFromJournal || vendorFromPrompt || "supplier";

  const totalPaid = j.reduce((s, l) => s + Number(l?.credit || 0), 0);
  const dateISO =
    (documentFields?.invoice?.date) ||
    (documentFields?.payment_voucher?.date) ||
    new Date().toISOString().slice(0, 10);

  const pv = { payee: vendorName, amount: Math.round(totalPaid * 100) / 100, date: dateISO, mode: hasBankCr ? "NEFT" : "cash", purpose: "purchase" };
  const newDF = { ...documentFields, payment_voucher: { ...(documentFields?.payment_voucher || {}), ...pv } };
  return { docType: "payment_voucher", documentFields: newDF };
}

// Capital/loan inflows: instrument Dr + capital/loan Cr → treat as receipt
function coerceDocTypeForCapitalOrLoanReceipt(docType, documentFields, journal, promptStr = "") {
  const j = Array.isArray(journal) ? journal : [];
  const hasInstrumentDr = j.some(l => looksInstrument(l?.account) && Number(l?.debit || 0) > 0);
  const hasCapitalCr = j.some(l => /capital|share|equity/i.test(String(l?.account || "")) && Number(l?.credit || 0) > 0);
  const hasLoanCr = j.some(l => /loan|borrowings?|director\s*loan/i.test(String(l?.account || "")) && Number(l?.credit || 0) > 0);

  if (!(hasInstrumentDr && (hasCapitalCr || hasLoanCr))) return { docType, documentFields };

  const amount = j.reduce((s, l) => s + (looksInstrument(l?.account) ? Number(l?.debit || 0) : 0), 0);
  const dateISO = (documentFields?.receipt?.date) || (j[0]?.date) || new Date().toISOString().slice(0, 10);
  const payerFromPrompt = (promptStr.match(/director\s+([A-Za-z][^,]*)/)?.[1] || "").trim();
  const payer = payerFromPrompt || (hasCapitalCr ? "Promoter/Owner" : "Lender");

  const rcpt = { payer, amount: R2(amount), date: dateISO, mode: "NEFT" };
  const newDF = { ...documentFields, receipt: { ...(documentFields?.receipt || {}), ...rcpt } };
  return { docType: "receipt", documentFields: newDF };
}

/* ========================= Admin/dev gate ========================= */
function isAdminRequest(req) {
  const key = req.headers?.["x-admin-key"];
  const devAllowed = process.env.NODE_ENV !== "production" && process.env.DEV_ADMIN_KEY && key === process.env.DEV_ADMIN_KEY;
  const jwtAllowed = !!(req.user && Array.isArray(req.user.roles) && req.user.roles.includes("superadmin"));
  return devAllowed || jwtAllowed;
}

/* ========================= Session memory ========================= */
const sessionMemory = Object.create(null);
function getMem(sessionId) {
  if (!sessionMemory[sessionId]) {
    sessionMemory[sessionId] = {
      rootPrompt: null, answers: [], clarifications: [],
      lastStatus: "idle", lastDocType: null,
      draft: { documentFields: null, journal: null },
      updatedAt: Date.now()
    };
  }
  return sessionMemory[sessionId];
}
function resetMem(sessionId) { delete sessionMemory[sessionId]; }

/* ========================= Small utils ========================= */
function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.randomBytes(1)[0] & 15 >> c/4).toString(16));
}
function sha256(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function send(res, payload, { debug = false } = {}) {
  const allowed = [
    "success", "status", "clarification",
    "promptType", "docType",
    "previewId", "hash", "expiresAt",
    "journal", "ledgerView",
    "explanation",
    "warnings", "errors", "newAccounts",
    "documentFields", "error",
    "__debug"
  ];
  const out = {};
  for (const k of allowed) if (k in (payload || {})) out[k] = payload[k];

  if (debug) {
    const dbg = {};
    if ("classifier" in payload)        dbg.classifier = payload.classifier;
    if ("chosenDocTypeHint" in payload) dbg.chosenDocTypeHint = payload.chosenDocTypeHint;
    if ("hydratedSignals" in payload)   dbg.hydratedSignals = payload.hydratedSignals;
    if ("fallbackUsed" in payload)      dbg.fallbackUsed = payload.fallbackUsed;
    if ("rawOutput" in payload)         dbg.rawOutput = payload.rawOutput;
    if ("_dev" in payload)              dbg._dev = payload._dev;
    out.__debug = dbg;
  }
  return res.status(200).json(out);
}

/* ========================= Prompt composition ========================= */
function buildCombinedPrompt(mem) {
  const parts = [];
  if (mem.rootPrompt) parts.push(`Original request:\n${mem.rootPrompt}`);
  if (Array.isArray(mem.answers) && mem.answers.length > 0) {
    const bullets = mem.answers.map((a) => `- ${a}`).join("\n");
    parts.push(`Additional details from user:\n${bullets}`);
  }
  if (mem.draft && mem.draft.documentFields) {
    const pretty = JSON.stringify(mem.draft.documentFields, null, 2);
    parts.push(`Known document fields so far (from preview):\n${pretty}`);
  }
  parts.push("Use ALL details above as a single transaction. If any critical field is still missing, ask ONE concise clarification.");
  return parts.join("\n\n");
}

/* ========================= Edit helpers ========================= */
function applyEdits(journal, edits) {
  if (!Array.isArray(journal)) return [];
  if (!edits || (typeof edits !== "object" && !Array.isArray(edits))) return journal;
  const clone = journal.map((r) => ({ ...r }));
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (!e || !Number.isInteger(e.index)) continue;
      const i = e.index;
      if (!clone[i]) continue;
      const t = clone[i];
      if (typeof e.account === "string") t.account = e.account.trim();
      if (typeof e.narration === "string") t.narration = e.narration;
      if (e.debit != null) t.debit = Number(e.debit);
      if (e.credit != null) t.credit = Number(e.credit);
      if (typeof e.date === "string") t.date = e.date;
    }
  } else {
    for (const k of Object.keys(edits)) {
      const i = Number(k);
      if (!Number.isInteger(i) || !clone[i]) continue;
      const patch = edits[k];
      if (!patch || typeof patch !== "object") continue;
      const t = clone[i];
      if (typeof patch.account === "string") t.account = patch.account.trim();
      if (typeof patch.narration === "string") t.narration = patch.narration;
      if (patch.debit != null) t.debit = Number(patch.debit);
      if (patch.credit != null) t.credit = Number(patch.credit);
      if (typeof patch.date === "string") t.date = patch.date;
    }
  }
  return clone;
}
function applyDocFieldEdits(currentDF, docType, docFieldEdits) {
  if (!docFieldEdits || typeof docFieldEdits !== "object") return currentDF;
  if (!docType || docType === "none") return currentDF;
  const src =
    docType === "payment_voucher"
      ? (docFieldEdits.payment_voucher || docFieldEdits.voucher || null)
      : docFieldEdits[docType] || null;
  if (!src) return currentDF;
  const base = (currentDF && typeof currentDF === "object") ? currentDF : {};
  const existing = base[docType] || {};
  return { ...base, [docType]: { ...existing, ...src } };
}

/* ========================= Validation helpers ========================= */
const DOC_TYPES_WITH_DEFAULT_DATE = new Set(["invoice", "receipt", "payment_voucher", "contra_voucher"]);
const HARD_ERROR_CODES = new Set([
  "SHAPE_MIN_LINES", "DRCR_EXCLUSIVE", "NOT_BALANCED",
  "BANK_SINGLELINE", "BANK_MIXED", "TOTALS_MISMATCH",
  "NUMBER_UNAVAILABLE", "PERIOD_LOCKED", "DATE_INVALID", "INV_ITEM_MISSING",
  "BANK_CASH_INSUFFICIENT" // funds/headroom failures must block preview
]);
function partitionValidation(validation) {
  const errs = Array.isArray(validation?.errors) ? validation.errors : [];
  const warns = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const hardErrors = [];
  const softErrors = [];
  for (const e of errs) (HARD_ERROR_CODES.has(e.code) ? hardErrors : softErrors).push(e);
  const mergedWarnings = warns.concat(softErrors.map(e => ({ ...e, level: "warn" })));
  return { hardErrors, mergedWarnings };
}
function extractNewAccountsFromValidation(validation) {
  const out = new Set();
  const scan = (arr) => {
    for (const e of arr || []) {
      if (e?.code === "LEDGER_MISSING" && e.meta?.account) out.add(String(e.meta.account).trim());
    }
  };
  scan(validation?.errors); scan(validation?.warnings);
  return Array.from(out);
}
function stripLedgerMissing(warnings) {
  return (warnings || []).filter(w => String(w.code) !== "LEDGER_MISSING");
}
function fundsClarification(errors) {
  const e = (errors || []).find(x => String(x?.code) === "BANK_CASH_INSUFFICIENT");
  if (!e) return null;

  const acctName = String(e?.meta?.account || "").toLowerCase();
  const short = typeof e?.meta?.short_cents === "number" ? (e.meta.short_cents / 100).toFixed(2) : null;
  const date  = e?.meta?.date ? ` as of ${e.meta.date}` : "";

  if (/\bcash\b/.test(acctName)) {
    return `Cash is short${date}${short ? ` by ₹${short}` : ""}. Should I book this as an out‑of‑pocket expense to be reimbursed later? If yes, tell me who paid (e.g., “reimburse to Rahul”). If no, say a mode like “use bank” and name the bank if not the default.`;
  }
  return e?.message || `Insufficient funds${date}. You can change the bank account, change the date, or add funds.`;
}

/* ========================= Preview-time COA ensure ========================= */
async function ensureAccountsExistForJournalPreview(journal, sid) {
  const seen = new Set();
  for (const l of journal || []) {
    const name = String(l?.account || "").trim();
    if (!name || seen.has(name)) continue;
    await ensureLedgerExists(name, sid); // idempotent, tenant-scoped
    seen.add(name);
  }
}

/* ========================= Intent plumbing ========================= */
function normalizeDocTypeHint(t) {
  const x = String(t || "").toLowerCase();
  if (x === "voucher") return "payment_voucher";
  if (x === "contra" || x === "contra_voucher") return "contra_voucher";
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(x)) return "payment_voucher";
  if (x === "invoice" || x === "receipt" || x === "payment_voucher" || x === "none") return x;
  return "none";
}
function chooseDocTypeHint(cls, parsedDocType) {
  const low = (s) => String(s || "").toLowerCase();
  switch (low(cls?.flow)) {
    case "payment_voucher": return "payment_voucher";
    case "receipt": return "receipt";
    case "vendor_credit": return "invoice";
    case "contra": return "contra_voucher";
    case "ignore_outbound": return "none";
  }
  const sem = low(cls?.docSemanticType || cls?.semanticType);
  if (sem === "contra_voucher") return "contra_voucher";
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(sem)) return "payment_voucher";
  if (["receipt","payment_receipt","expense_receipt"].includes(sem)) return "receipt";
  if (["credit_note","vendor_credit"].includes(sem)) return "invoice";
  const parsed = low(parsedDocType);
  if (parsed === "contra_voucher") return "contra_voucher";
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(parsed)) return "payment_voucher";
  if (["receipt","payment_receipt","expense_receipt"].includes(parsed)) return "receipt";
  const p = low(cls?.promptType);
  if (p) return normalizeDocTypeHint(p);
  return normalizeDocTypeHint(cls?.type);
}
function stdPayMode(modeRaw) {
  const m = String(modeRaw || "").toLowerCase();
  if (!m) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim)/i.test(m)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(m)) return "BANK";
  if (/(card|visa|master|debit|credit)/i.test(m)) return "CARD";
  if (/cash/i.test(m)) return "CASH";
  if (/(cheque|check|chq)/i.test(m)) return "CHEQUE";
  return modeRaw;
}
function deriveSignalsFromParsed(flow, parsedDocType, parsedFields, clsSignals) {
  const s = { ...(clsSignals || {}) };
  if (!s.payee) s.payee = parsedFields.vendor_name || parsedFields.supplier_name || parsedFields.payee || null;
  if (s.amount == null) s.amount = (parsedFields.total_amount ?? parsedFields.amount ?? null);
  if (!s.date) s.date = parsedFields.invoice_date || parsedFields.receipt_date || parsedFields.document_date || parsedFields.date || null;
  // IMPORTANT: Do NOT fallback from "paid === true" to BANK. Mode must be explicit.
  if (!s.mode) s.mode = stdPayMode(parsedFields.payment_mode || parsedFields.mode || null);
  if (!s.payment_mode && s.mode) s.payment_mode = s.mode;
  if (!s.flow) s.flow = flow || (parsedDocType ? normalizeDocTypeHint(parsedDocType) : null);
  return s;
}

/* ========================= Raw-text intent helpers ========================= */
function clipRawText(s, limit = 18000) {
  if (!s || typeof s !== "string") return "";
  const t = s.replace(/\u0000/g, "");
  return t.length > limit ? t.slice(0, limit) : t;
}
function buildIntentProbe(rawText) {
  const raw = clipRawText(rawText || ""); if (!raw) return "";
  return [
    "You are classifying the NATURE of a business document from RAW OCR text.",
    "CRITICAL RULES:",
    " - Decide ONLY intent/direction/type (e.g., vendor invoice, expense receipt, delivery note, vendor credit, payment voucher).",
    " - Treat all numbers, totals, taxes and dates in the raw text as UNRELIABLE.",
    " - DO NOT derive any numeric values from this raw text. Numbers come from structured fields separately.",
    "Raw document text (read-only, unreliable for numbers):",
    raw
  ].join("\n");
}
function buildInferenceContext(rawText, parsedFields) {
  const raw = clipRawText(rawText || "");
  const payee = parsedFields?.vendor_name || parsedFields?.supplier_name || parsedFields?.payee || "";
  const mode = parsedFields?.payment_mode || parsedFields?.mode || "";
  return [
    "Context for semantics (names/phrases only).",
    "Ignore any numbers/dates/totals/taxes in this raw context:",
    raw ? raw : "(no raw text provided)",
    "",
    "Authoritative structured fields (use these for ALL numbers/dates):",
    JSON.stringify({
      payee, mode,
      amount: parsedFields?.total_amount ?? parsedFields?.amount ?? null,
      date: parsedFields?.invoice_date ?? parsedFields?.receipt_date ?? parsedFields?.date ?? null
    })
  ].join("\n");
}

/* ========================= Doc model helper ========================= */
function buildDocModel(docType, documentFields, journal) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const dfByType =
    (documentFields && typeof documentFields === "object")
      ? (docType === "payment_voucher"
          ? (documentFields.payment_voucher || documentFields.voucher || {})
          : (documentFields[docType] || {}))
      : {};
  const lineDate = Array.isArray(journal) && journal[0]?.date ? journal[0].date : null;
  const shouldDefaultDate = DOC_TYPES_WITH_DEFAULT_DATE.has(docType);
  const dm = { ...(dfByType || {}), date: dfByType.date || lineDate || (shouldDefaultDate ? todayISO : undefined) };
  if (dm.items && !Array.isArray(dm.items)) dm.items = [];
  return dm;
}

/* ========================= Exported helper ========================= */
export const clearOrchestratorSession = (sessionId = "default-session") => { resetMem(sessionId); };

/* ========================= STRUCTURED-DOC FLOW ========================= */
async function runStructuredDocFlow({ parsedDocType, parsedFields, sessionId, idempotencyKey, debug, rawText }, res) {
  const intentProbe = buildIntentProbe(rawText);
  const cls = await classifyPromptType({
    currentPrompt: intentProbe, previousFollowUpChain: [],
    parsedDocType, parsedFields, source: "extraction", inboundOnly: true
  });

  if (cls.flow === "ignore_outbound") {
    return send(res, {
      success: true, status: "followup_needed",
      clarification: "This appears to be an outbound document issued by your own business. The upload parser handles inbound docs only.",
      docType: "none", promptType: "none", classifier: cls
    }, { debug });
  }

  const docTypeHint = chooseDocTypeHint(cls, parsedDocType);
  const hydratedSignals = deriveSignalsFromParsed(cls.flow, parsedDocType, parsedFields, cls.signals);
  const context = buildInferenceContext(rawText, parsedFields);

  // ASK-FIRST policy (skip when contra intent is detected or contra hinted)
  const looksContra = (docTypeHint === "contra_voucher") || (detectContraIntent(rawText || "") !== "NONE");
  if (!looksContra && (docTypeHint === "payment_voucher" || docTypeHint === "receipt")) {
    const mode = explicitModeFromSignals(parsedFields, rawText);
    if (!mode) {
      return send(res, {
        success: true, status: "followup_needed",
        clarification: "How was this paid? Choose one: Cash, or Bank (UPI/NEFT/Card). If Bank, you can also say which bank; otherwise I’ll use your default bank.",
        docType: docTypeHint, promptType: docTypeHint, classifier: cls
      }, { debug });
    }
  }

  const accountantPrompt = buildCanonicalPromptFromSignals(docTypeHint, hydratedSignals, context);
  const inferred = await inferJournalEntriesFromPrompt(accountantPrompt, docTypeHint);
  const baseJournal = enforceAll(inferred?.journal || [], parsedFields, rawText || "");

  // CONTRA first; else directional instrument placement
  const { journal: contraJ, applied: contraApplied } =
    await applyContraIfDetected(baseJournal, sessionId, rawText || "");
  const finalJournal = contraApplied
    ? contraJ
    : await applyDefaultSpendingAccount(baseJournal, parsedFields, sessionId, rawText || "", docTypeHint);

  // Treat as contra if hinted/applied/shape matches
  const isContraFlow = (docTypeHint === "contra_voucher") || contraApplied || isContraJournalShape(finalJournal);

  if (inferred && inferred.status === "followup_needed") {
    let question = inferred.clarification || "Please provide the missing detail.";
    if (isContraFlow && isPayeeClarification(question)) {
      question = "For the contra, please confirm the amount, whether it is Bank→Cash or Cash→Bank, and which bank account (or say 'use default bank').";
    }
    return send(res, {
      success: true, status: "followup_needed", clarification: question,
      docType: isContraFlow ? "contra_voucher" : (inferred.docType || "none"),
      promptType: docTypeHint || null, classifier: cls, fallbackUsed: inferred.fallbackUsed
    }, { debug });
  }
  if (!inferred || inferred.status !== "success" || !Array.isArray(finalJournal)) {
    return send(res, {
      success: false, status: inferred?.status || "invalid",
      error: inferred?.message || "Could not infer a valid journal from the extracted fields.",
      promptType: docTypeHint || null, classifier: cls, fallbackUsed: inferred?.fallbackUsed
    }, { debug });
  }

  // Coercions (contra; purchase; capital/loan receipts)
  let docType = isContraFlow
    ? "contra_voucher"
    : (typeof inferred.docType === "string" ? inferred.docType : "none");

  let documentFields = (inferred && inferred.documentFields && typeof inferred.documentFields === "object") ? inferred.documentFields : {};
  if (isContraFlow) {
    documentFields = { ...documentFields, ...buildContraDocumentFields(finalJournal, documentFields) };
  } else {
    ({ docType, documentFields } = coerceDocTypeForPurchase(docType, documentFields, finalJournal, "" /* no NL */));
    ({ docType, documentFields } = coerceDocTypeForCapitalOrLoanReceipt(docType, documentFields, finalJournal, "" /* no NL */));
  }

  const docModel = buildDocModel(docType, documentFields, finalJournal);

  const validation = await runValidation({
    docType, journal: finalJournal, docModel,
    tz: "Asia/Kolkata", mode: "preview",
    plannedIdempotencyKey: idempotencyKey || null,
    sessionId // pass tenant for funds guard
  });

  let { hardErrors, mergedWarnings } = partitionValidation(validation);
  if (isContraFlow) {
    hardErrors = hardErrors.filter(e => String(e.code) !== "BANK_MIXED");
  }
  if (hardErrors.length) {
    const clar = fundsClarification(hardErrors);
    return send(res, {
      success: false, status: "invalid",
      errors: hardErrors, warnings: stripLedgerMissing(mergedWarnings),
      promptType: docTypeHint || null, ...(clar ? { clarification: clar } : {})
    }, { debug });
  }

  // Auto-create COA for preview (no user friction)
  await ensureAccountsExistForJournalPreview(finalJournal, sessionId);

  const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
  const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp", sessionId });

  const previewPayload = { docType, docModel: { ...docModel, number: reservation.number }, journal: finalJournal };
  const snap = await createSnapshot({ docType, payload: previewPayload, reservation, sessionId, userId: null });

  try {
    await createFundsHolds({ sessionId, journal: finalJournal, defaultDate: dateISO, previewId: snap.previewId });
  } catch (e) { console.warn("Funds holds creation failed (non-fatal):", e?.message || e); }

  const ledgerView = buildLedgerView(finalJournal);
  return send(res, {
    success: true, status: "preview",
    previewId: snap.previewId, hash: snap.hash, expiresAt: snap.expiresAt,
    promptType: docTypeHint || null, journal: finalJournal, ledgerView,
    explanation: inferred.explanation || "Review and confirm the journal.",
    newAccounts: [], // created already
    warnings: stripLedgerMissing(mergedWarnings),
    docType, documentFields, classifier: cls
  }, { debug });
}

/* ========================= Controller ========================= */
export const orchestratePrompt = async (req, res) => {
  try {
    // Tenant guard
    if (typeof req.sessionId === "undefined") {
      return res.status(500).json({ success: false, status: "error", message: "Tenant middleware not initialized." });
    }
    const sid = req.sessionId;
    if (sid === null) {
      return res.status(400).json({ success: false, status: "error", message: "Workspace required (cannot use ALL for orchestration writes)." });
    }

    const { prompt, resetSession = false, edits, docFieldEdits, idempotencyKey, source } = req.body || {};
    const debugRequested = (process.env.DEBUG_ORCHESTRATOR === "1") ||
                           (String(req.query?.debug || "") === "1") ||
                           (String(req.headers["x-debug"] || "") === "1");
    const debug = debugRequested && isAdminRequest(req);

    // Structured extraction path
    const parsedDocType = (req.body?.docType || req.body?.documentType || "").toString().toLowerCase();
    const parsedFields =
      req.body?.fields || req.body?.documentFields ||
      ((docFieldEdits && parsedDocType && docFieldEdits[parsedDocType]) || {}) || {};
    const structuredMode = source === "extraction" || parsedDocType || Object.keys(parsedFields).length > 0;
    const rawTextFromReq = String(req.body?.meta?.rawText || req.body?.rawText || "");

    if (structuredMode && !edits) {
      return await runStructuredDocFlow({ parsedDocType, parsedFields, sessionId: sid, idempotencyKey, debug, rawText: rawTextFromReq }, res);
    }

    /* ---------- PREVIEW EDIT (keyed by workspace sid) ---------- */
    if (resetSession) resetMem(sid);
    let mem = getMem(sid);

    const hasEdits = !!edits;
    const hasDocFieldEdits = !!docFieldEdits;
    const hasDraft = !!(mem.draft && Array.isArray(mem.draft.journal) && mem.draft.journal.length > 0);

    if ((hasEdits || hasDocFieldEdits) && hasDraft) {
      if (hasDocFieldEdits) {
        mem.draft.documentFields = applyDocFieldEdits(mem.draft.documentFields || {}, mem.lastDocType || "none", docFieldEdits);
      }
      const editedJournal = hasEdits ? applyEdits(mem.draft.journal, edits) : mem.draft.journal;

      let docType = mem.lastDocType || "none";
      ({ docType, documentFields: mem.draft.documentFields } =
        coerceDocTypeForPurchase(docType, mem.draft.documentFields || {}, editedJournal, mem.rootPrompt));
      ({ docType, documentFields: mem.draft.documentFields } =
        coerceDocTypeForCapitalOrLoanReceipt(docType, mem.draft.documentFields || {}, editedJournal, mem.rootPrompt));

      const fieldsForSpending =
        (docType === "payment_voucher"
          ? (mem.draft.documentFields?.payment_voucher || mem.draft.documentFields?.voucher || {})
          : (mem.draft.documentFields?.[docType] || {})) || {};

      // CONTRA first; else directional instrument placement
      const { journal: contraJ, applied: contraApplied } =
        await applyContraIfDetected(editedJournal, sid, mem.rootPrompt || "");
      const journalWithAccount = contraApplied
        ? contraJ
        : await applyDefaultSpendingAccount(editedJournal, fieldsForSpending, sid, mem.rootPrompt || "", docType);

      const isContraFlow = contraApplied || isContraJournalShape(journalWithAccount);
      if (isContraFlow) docType = "contra_voucher";

      let docModel = buildDocModel(docType, mem.draft.documentFields, journalWithAccount);

      const validation = await runValidation({
        docType, journal: journalWithAccount, docModel,
        tz: "Asia/Kolkata", mode: "preview",
        plannedIdempotencyKey: idempotencyKey || null,
        sessionId: sid
      });

      let { hardErrors, mergedWarnings } = partitionValidation(validation);
      if (isContraFlow) hardErrors = hardErrors.filter(e => String(e.code) !== "BANK_MIXED");
      if (hardErrors.length) {
        const clar = fundsClarification(hardErrors);
        return send(res, {
          success: false, status: "invalid",
          errors: hardErrors, warnings: stripLedgerMissing(mergedWarnings),
          promptType: docType, ...(clar ? { clarification: clar } : {})
        }, { debug });
      }

      await ensureAccountsExistForJournalPreview(journalWithAccount, sid);

      const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
      const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp", sessionId: sid });

      const previewPayload = { docType, docModel: { ...docModel, number: reservation.number }, journal: journalWithAccount };
      const snap = await createSnapshot({ docType, payload: previewPayload, reservation, sessionId: sid, userId: req.body?.userId || null });

      try {
        await createFundsHolds({ sessionId: sid, journal: journalWithAccount, defaultDate: dateISO, previewId: snap.previewId });
      } catch (e) { console.warn("Funds holds creation failed (non-fatal):", e?.message || e); }

      mem.draft.journal = journalWithAccount;
      mem.lastStatus = "preview"; mem.updatedAt = Date.now();

      const ledgerView = buildLedgerView(journalWithAccount);

      return send(res, {
        success: true, status: "preview",
        previewId: snap.previewId, hash: snap.hash, expiresAt: snap.expiresAt,
        promptType: docType, journal: journalWithAccount, ledgerView,
        explanation: "Review and confirm the journal.",
        newAccounts: [], warnings: stripLedgerMissing(mergedWarnings),
        docType, documentFields: mem.draft.documentFields || {},
      }, { debug });
    }

    /* ---------- NL FLOW (chat) ---------- */
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      return res.status(400).json({ success: false, status: "error", message: "Prompt cannot be empty (or provide 'edits' for preview re-render)." });
    }

    // SESSION ROLLOVER RULE: if not in clarification, start a new document on this prompt
    const continuingClarification = mem.lastStatus === "followup_needed" && mem.clarifications.length > 0;
    if (!continuingClarification) {
      resetMem(sid); mem = getMem(sid);
      mem.rootPrompt = prompt.trim(); mem.answers = []; mem.clarifications = [];
      mem.lastStatus = "pending"; mem.lastDocType = null;
      mem.draft = { documentFields: null, journal: null };
    } else {
      mem.answers.push(prompt.trim());
    }
    mem.updatedAt = Date.now();

    const combinedPrompt = continuingClarification ? buildCombinedPrompt(mem) : mem.rootPrompt;

    const cls = await classifyPromptType({
      currentPrompt: combinedPrompt,
      previousFollowUpChain: mem.clarifications,
      parsedDocType, parsedFields
    });

    if (cls.flow === "ignore_outbound") {
      mem.lastStatus = "followup_needed";
      return send(res, {
        success: true, status: "followup_needed",
        clarification: "This appears to be an outbound document issued by your own business. The upload parser handles inbound docs only.",
        docType: "none", promptType: "none", classifier: cls
      }, { debug });
    }

    const docTypeHint = chooseDocTypeHint(cls, parsedDocType);

    // ASK-FIRST policy (skip when contra hinted or detected by text)
    const looksContra = (docTypeHint === "contra_voucher") || (detectContraIntent(combinedPrompt || "") !== "NONE");
    if (!looksContra && (docTypeHint === "payment_voucher" || docTypeHint === "receipt")) {
      // For NL flow, rely on raw text only (don’t trust classifier guesses for mode)
      const mode = explicitModeFromSignals({}, combinedPrompt);
      if (!mode) {
        const q = "How was this paid? Choose one: Cash, or Bank (UPI/NEFT/Card). If Bank, you can also say which bank; otherwise I’ll use your default bank.";
        mem.clarifications.push(q);
        mem.lastStatus = "followup_needed";
        mem.lastDocType = docTypeHint;
        mem.updatedAt = Date.now();
        return send(res, {
          success: true, status: "followup_needed",
          clarification: q,
          docType: docTypeHint, promptType: docTypeHint,
          classifier: cls, chosenDocTypeHint: docTypeHint
        }, { debug });
      }
    }

    const strongSignals = deriveSignalsFromParsed(cls.flow, parsedDocType, parsedFields, cls.signals);
    const accountantPrompt = buildCanonicalPromptFromSignals(docTypeHint, strongSignals, combinedPrompt);

    const inferred = await inferJournalEntriesFromPrompt(accountantPrompt, docTypeHint);
    const baseJournal = enforceAll(inferred?.journal || [], strongSignals, combinedPrompt || "");

    // CONTRA first; else directional instrument placement
    const { journal: contraJ, applied: contraApplied } =
      await applyContraIfDetected(baseJournal, sid, combinedPrompt || "");
    const finalJournal = contraApplied
      ? contraJ
      : await applyDefaultSpendingAccount(baseJournal, strongSignals, sid, combinedPrompt || "", docTypeHint);

    // Decide contra flow (hinted/applied/shape)
    const isContraFlow = (docTypeHint === "contra_voucher") || contraApplied || isContraJournalShape(finalJournal);

    if (inferred && inferred.status === "followup_needed") {
      let question = inferred.clarification || "Please provide the missing detail.";
      if (isContraFlow && isPayeeClarification(question)) {
        question = "For the contra, please confirm the amount, whether it is Bank→Cash or Cash→Bank, and which bank account (or say 'use default bank').";
      }
      mem.clarifications.push(question);
      mem.lastStatus = "followup_needed";
      mem.lastDocType = isContraFlow ? "contra_voucher" : (inferred.docType || mem.lastDocType || "none");
      mem.updatedAt = Date.now();

      return send(res, {
        success: true, status: "followup_needed",
        clarification: question,
        docType: mem.lastDocType || "none", promptType: docTypeHint || null,
        classifier: cls, fallbackUsed: inferred.fallbackUsed, chosenDocTypeHint: docTypeHint
      }, { debug });
    }

    if (!inferred || inferred.status !== "success" || !Array.isArray(finalJournal)) {
      mem.lastStatus = "invalid"; mem.updatedAt = Date.now();
      return send(res, {
        success: false, status: inferred?.status || "invalid",
        error: inferred?.message || "Could not infer a valid journal from the prompt.",
        promptType: docTypeHint || null, classifier: cls, fallbackUsed: inferred?.fallbackUsed, chosenDocTypeHint: docTypeHint
      }, { debug });
    }

    let docType = isContraFlow
      ? "contra_voucher"
      : (typeof inferred.docType === "string" ? inferred.docType : "none");

    let documentFields =
      (inferred && inferred.documentFields && typeof inferred.documentFields === "object")
        ? inferred.documentFields : {};
    if (isContraFlow) {
      documentFields = { ...documentFields, ...buildContraDocumentFields(finalJournal, documentFields) };
    } else {
      ({ docType, documentFields } =
        coerceDocTypeForPurchase(docType, documentFields, finalJournal, mem.rootPrompt || prompt));
      ({ docType, documentFields } =
        coerceDocTypeForCapitalOrLoanReceipt(docType, documentFields, finalJournal, mem.rootPrompt || prompt));
    }

    const docModel = buildDocModel(docType, documentFields, finalJournal);

    const validation = await runValidation({
      docType, journal: finalJournal, docModel,
      tz: "Asia/Kolkata", mode: "preview",
      plannedIdempotencyKey: idempotencyKey || null,
      sessionId: sid
    });

    let { hardErrors, mergedWarnings } = partitionValidation(validation);
    if (isContraFlow) {
      hardErrors = hardErrors.filter(e => String(e.code) !== "BANK_MIXED");
    }
    if (hardErrors.length) {
      mem.lastStatus = "invalid"; mem.updatedAt = Date.now();
      const clar = fundsClarification(hardErrors);
      return send(res, {
        success: false, status: "invalid",
        errors: hardErrors, warnings: stripLedgerMissing(mergedWarnings),
        promptType: docTypeHint || null, ...(clar ? { clarification: clar } : {})
      }, { debug });
    }

    await ensureAccountsExistForJournalPreview(finalJournal, sid);

    const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
    const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp", sessionId: sid });

    const previewPayload = { docType, docModel: { ...docModel, number: reservation.number }, journal: finalJournal };
    const snap = await createSnapshot({ docType, payload: previewPayload, reservation, sessionId: sid, userId: req.body?.userId || null });

    try {
      await createFundsHolds({ sessionId: sid, journal: finalJournal, defaultDate: dateISO, previewId: snap.previewId });
    } catch (e) { console.warn("Funds holds creation failed (non-fatal):", e?.message || e); }

    const ledgerView = buildLedgerView(finalJournal);

    mem.lastStatus = "preview";
    mem.lastDocType = docType || mem.lastDocType || "none";
    mem.draft = { documentFields, journal: finalJournal };
    mem.updatedAt = Date.now();

    return send(res, {
      success: true, status: "preview",
      previewId: snap.previewId, hash: snap.hash, expiresAt: snap.expiresAt,
      promptType: docTypeHint || null, journal: finalJournal, ledgerView,
      explanation: inferred.explanation || "Review and confirm the journal.",
      newAccounts: [], warnings: stripLedgerMissing(mergedWarnings),
      docType: mem.lastDocType || "none", documentFields: mem.draft.documentFields || {},
      classifier: cls, chosenDocTypeHint: docTypeHint
    }, { debug });

  } catch (err) {
    console.error("🚨 Orchestration Error:", err);
    const sid = req.sessionId || "default-session";
    getMem(sid).lastStatus = "error";
    return res.status(500).json({ success: false, status: "error", message: "Internal server error during orchestration." });
  }
};
