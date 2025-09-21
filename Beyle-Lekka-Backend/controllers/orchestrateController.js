// controllers/orchestrateController.js

import crypto from "crypto";
import { inferJournalEntriesFromPrompt } from "../utils/mergedInferAccountingFromPrompt.js";
import { classifyPromptType, buildCanonicalPromptFromSignals } from "../utils/classifyPromptType.js";
import { buildLedgerView } from "../utils/jeCore.js";
import { runValidation } from "../utils/validation/index.js";
import { reserveSeries } from "../services/series.js";
import { createSnapshot } from "../utils/preview/snapshotStore.js";

/* =======================================================================
   PRODUCTION DETERMINISTIC ENFORCEMENT (embedded here for drop-in safety)
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
  roundOffDr: "Round-off (Expense)"
};
function normalizePayMode(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim|paytm|qr)/i.test(s)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(s)) return "BANK";
  if (/(card|visa|master|rupay|debit|credit)/i.test(s)) return "CARD";
  if (/cash/i.test(s)) return "CASH";
  return null;
}
function enforceCreditFromMode(journal, fields) {
  const mode = normalizePayMode(fields?.payment_mode || fields?.mode || (fields?.paid ? "BANK" : null));
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

  const credits = (journal || []).filter(l => Number(l?.credit || 0) > 0);
  const debits  = (journal || []).filter(l => Number(l?.debit  || 0) > 0);
  const credit  = credits[0] || { account: LEDGERS.bank, credit: R2(total) };
  let   mainDr  = debits.find(l => !/GST|Tax/i.test(String(l?.account || ""))) || debits[0];

  // Errand/retail cues → default to Office Expenses
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
function enforceAll(journalIn, fields, rawTextForCues = "") {
  let j = Array.isArray(journalIn) ? journalIn.map(l => ({...l})) : [];
  j = ensureGstSplit(j, fields, { assumeIntra: true, preferExpense: true, text: rawTextForCues });
  j = enforceCreditFromMode(j, fields);
  j = addRoundOff(j);
  return j;
}

/* ========================= Session Mem ========================= */
const sessionMemory = Object.create(null);
function getMem(sessionId) {
  if (!sessionMemory[sessionId]) {
    sessionMemory[sessionId] = {
      rootPrompt: null,
      answers: [],
      clarifications: [],
      lastStatus: "idle",
      lastDocType: null,
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

// Central responder (whitelists keys + gated debug)
function send(res, payload, { debug = false } = {}) {
  const allowed = [
    "success", "status",
    "clarification",
    "promptType",
    "docType",
    "previewId", "hash", "expiresAt",
    "journal", "ledgerView",
    "explanation",
    "warnings", "errors", "newAccounts",
    "documentFields",
    "error"
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

/* ========================= Prompt composition (NL path) ========================= */
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
    const keys = Object.keys(edits);
    for (const k of keys) {
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
const DOC_TYPES_WITH_DEFAULT_DATE = new Set(["invoice", "receipt", "payment_voucher"]);
const HARD_ERROR_CODES = new Set([
  "SHAPE_MIN_LINES", "DRCR_EXCLUSIVE", "NOT_BALANCED",
  "BANK_SINGLELINE", "BANK_MIXED", "TOTALS_MISMATCH",
  "NUMBER_UNAVAILABLE", "PERIOD_LOCKED", "DATE_INVALID", "INV_ITEM_MISSING"
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

/* ========================= Hint & signal plumbing ========================= */
function normalizeDocTypeHint(t) {
  const x = String(t || "").toLowerCase();
  if (x === "voucher") return "payment_voucher";
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(x)) return "payment_voucher"; // inbound synonyms
  if (x === "invoice" || x === "receipt" || x === "payment_voucher" || x === "none") return x;
  return "none";
}
// Prefer flow → semantic doc → parsedDocType → promptType → type
function chooseDocTypeHint(cls, parsedDocType) {
  const low = (s) => String(s || "").toLowerCase();

  // 1) flow wins
  switch (low(cls?.flow)) {
    case "payment_voucher": return "payment_voucher";
    case "receipt": return "receipt";
    case "vendor_credit": return "invoice";          // until dedicated credit-note mode exists
    case "ignore_outbound": return "none";
  }

  // 2) semantic type
  const sem = low(cls?.docSemanticType || cls?.semanticType);
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(sem)) return "payment_voucher";
  if (["receipt","payment_receipt","expense_receipt"].includes(sem)) return "receipt";
  if (["credit_note","vendor_credit"].includes(sem)) return "invoice";

  // 3) extracted parsed docType
  const parsed = low(parsedDocType);
  if (["vendor_invoice","purchase_bill","purchase_invoice","bill","vendor_bill"].includes(parsed)) return "payment_voucher";
  if (["receipt","payment_receipt","expense_receipt"].includes(parsed)) return "receipt";

  // 4) fallbacks
  const p = low(cls?.promptType);
  if (p) return normalizeDocTypeHint(p);
  return normalizeDocTypeHint(cls?.type);
}
// Map extracted fields to voucher/receipt signals (ground truth)
function stdPayMode(modeRaw) {
  const m = String(modeRaw || "").toLowerCase();
  if (!m) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim)/i.test(m)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(m)) return "BANK";
  if (/(card|visa|master|debit|credit)/i.test(m)) return "CARD";
  if (/cash/i.test(m)) return "CASH";
  return modeRaw;
}
function deriveSignalsFromParsed(flow, parsedDocType, parsedFields, clsSignals) {
  const s = { ...(clsSignals || {}) };

  if (!s.payee) {
    s.payee =
      parsedFields.vendor_name ||
      parsedFields.supplier_name ||
      parsedFields.payee ||
      null;
  }
  if (s.amount == null) {
    const t = parsedFields.total_amount ?? parsedFields.amount ?? null;
    s.amount = (t != null) ? Number(t) : null;
  }
  if (!s.date) {
    s.date =
      parsedFields.invoice_date ||
      parsedFields.receipt_date ||
      parsedFields.document_date ||
      parsedFields.date ||
      null;
  }
  if (!s.mode) {
    s.mode = stdPayMode(parsedFields.payment_mode || parsedFields.mode || null);
    if (!s.mode && parsedFields.paid === true) s.mode = "BANK";
  }
  // bridge for prompt-builder so it can say "via UPI/BANK/CARD/CASH"
  if (!s.payment_mode && s.mode) s.payment_mode = s.mode;

  if (!s.flow) s.flow = flow || (parsedDocType ? normalizeDocTypeHint(parsedDocType) : null);
  return s;
}

/* ========================= Raw-text intent helpers (NEW) ========================= */
function clipRawText(s, limit = 18000) {
  if (!s || typeof s !== "string") return "";
  const t = s.replace(/\u0000/g, "");
  return t.length > limit ? t.slice(0, limit) : t;
}
function buildIntentProbe(rawText) {
  const raw = clipRawText(rawText || "");
  if (!raw) return "";
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

/* ========================= Purchase coercion & doc model helpers ========================= */
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

  if (docType !== "invoice" || !looksPurchase || (!hasBankCr && !hasCashCr)) {
    return { docType, documentFields };
  }

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

  const pv = {
    payee: vendorName,
    amount: Math.round(totalPaid * 100) / 100,
    date: dateISO,
    mode: hasBankCr ? "NEFT" : "cash",
    purpose: "purchase"
  };

  const newDF = {
    ...documentFields,
    payment_voucher: { ...(documentFields?.payment_voucher || {}), ...pv }
  };

  return { docType: "payment_voucher", documentFields: newDF };
}
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
export const clearOrchestratorSession = (sessionId = "default-session") => {
  resetMem(sessionId);
};

/* ========================= STRUCTURED-DOC FLOW (intent from raw, numbers from fields) ========================= */
async function runStructuredDocFlow({ parsedDocType, parsedFields, sessionId, idempotencyKey, debug, rawText }, res) {
  // 1) Classify intent using RAW TEXT ONLY for semantics (no numbers)
  const intentProbe = buildIntentProbe(rawText);
  const cls = await classifyPromptType({
    currentPrompt: intentProbe,          // <= raw text used for semantic type only
    previousFollowUpChain: [],
    parsedDocType,                       // structured hints
    parsedFields,
    source: "extraction",
    inboundOnly: true                    // hint for implementations that support it
  });

  if (cls.flow === "ignore_outbound") {
    return send(res, {
      success: true,
      status: "followup_needed",
      clarification: "This appears to be an outbound document issued by your own business. The upload parser handles inbound docs only.",
      docType: "none",
      promptType: "none",
      classifier: cls
    }, { debug });
  }

  // 2) Turn classifier + structured fields into signals and a strong hint
  const docTypeHint = chooseDocTypeHint(cls, parsedDocType);
  const hydratedSignals = deriveSignalsFromParsed(cls.flow, parsedDocType, parsedFields, cls.signals);

  // 3) Build the accountant prompt: give raw context for words, but gate numbers to structured
  const context = buildInferenceContext(rawText, parsedFields);
  const accountantPrompt = buildCanonicalPromptFromSignals(docTypeHint, hydratedSignals, context);

  // 4) Infer JE with hint; model must respect structured amounts/dates
  const inferred = await inferJournalEntriesFromPrompt(accountantPrompt, docTypeHint);
  const finalJournal = enforceAll(inferred?.journal || [], parsedFields, rawText || "");

  if (inferred && inferred.status === "followup_needed") {
    const question = inferred.clarification || "Please provide the missing detail.";
    return send(res, {
      success: true,
      status: "followup_needed",
      clarification: question,
      docType: inferred.docType || "none",
      promptType: docTypeHint || null,
      classifier: cls,
      fallbackUsed: inferred.fallbackUsed
    }, { debug });
  }

  if (!inferred || inferred.status !== "success" || !Array.isArray(finalJournal)) {
    return send(res, {
      success: false,
      status: inferred?.status || "invalid",
      error: inferred?.message || "Could not infer a valid journal from the extracted fields.",
      promptType: docTypeHint || null,
      classifier: cls,
      fallbackUsed: inferred?.fallbackUsed
    }, { debug });
  }

  // 5) Usual validation → reservation → snapshot → preview
  let docType = (inferred && typeof inferred.docType === "string") ? inferred.docType : "none";
  let documentFields =
    (inferred && inferred.documentFields && typeof inferred.documentFields === "object")
      ? inferred.documentFields
      : {};

  ({ docType, documentFields } =
    coerceDocTypeForPurchase(docType, documentFields, finalJournal, "" /* no NL */));

  const docModel = buildDocModel(docType, documentFields, finalJournal);

  const validation = await runValidation({
    docType,
    journal: finalJournal,
    docModel,
    tz: "Asia/Kolkata",
    mode: "preview",
    plannedIdempotencyKey: idempotencyKey || null
  });

  const { hardErrors, mergedWarnings } = partitionValidation(validation);
  if (hardErrors.length) {
    return send(res, {
      success: false,
      status: "invalid",
      errors: hardErrors,
      warnings: mergedWarnings,
      promptType: docTypeHint || null
    }, { debug });
  }

  const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
  const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp" });

  const previewPayload = {
    docType,
    docModel: { ...docModel, number: reservation.number },
    journal: finalJournal
  };

  const snap = await createSnapshot({
    docType,
    payload: previewPayload,
    reservation,
    sessionId,
    userId: null
  });

  const ledgerView = buildLedgerView(finalJournal);

  return send(res, {
    success: true,
    status: "preview",
    previewId: snap.previewId,
    hash: snap.hash,
    expiresAt: snap.expiresAt,
    promptType: docTypeHint || null,
    journal: finalJournal,
    ledgerView,
    explanation: inferred.explanation || "Review and confirm the journal.",
    newAccounts: extractNewAccountsFromValidation(validation),
    warnings: mergedWarnings,
    docType,
    documentFields,
    classifier: cls
  }, { debug });
}

/* ========================= Controller ========================= */
export const orchestratePrompt = async (req, res) => {
  try {
    const {
      prompt,
      sessionId = "default-session",
      resetSession = false,
      edits,
      docFieldEdits,
      idempotencyKey,
      source
    } = req.body || {};

    const debug = (process.env.DEBUG_ORCHESTRATOR === "1") ||
                  (String(req.query?.debug || "") === "1") ||
                  (String(req.headers["x-debug"] || "") === "1");

    // Parsed info from Docs page (structured)
    const parsedDocType =
      (req.body?.docType || req.body?.documentType || "").toString().toLowerCase();
    const parsedFields =
      req.body?.fields || req.body?.documentFields ||
      ((docFieldEdits && parsedDocType && docFieldEdits[parsedDocType]) || {}) || {};

    // Structured-doc flow when extraction data present (and not editing an existing draft)
    const structuredMode = source === "extraction" || parsedDocType || Object.keys(parsedFields).length > 0;
    if (structuredMode && !edits) {
      const rawText = String(req.body?.meta?.rawText || req.body?.rawText || "");
      return await runStructuredDocFlow(
        { parsedDocType, parsedFields, sessionId, idempotencyKey, debug, rawText },
        res
      );
    }

    /* ---------- PREVIEW EDIT (unchanged logic) ---------- */
    if (resetSession) resetMem(sessionId);
    const mem = getMem(sessionId);

    const hasEdits = !!edits;
    const hasDocFieldEdits = !!docFieldEdits;
    const hasDraft = !!(mem.draft && Array.isArray(mem.draft.journal) && mem.draft.journal.length > 0);

    if ((hasEdits || hasDocFieldEdits) && hasDraft) {
      if (hasDocFieldEdits) {
        const newDF = applyDocFieldEdits(mem.draft.documentFields || {}, mem.lastDocType || "none", docFieldEdits);
        mem.draft.documentFields = newDF;
      }
      const editedJournal = hasEdits ? applyEdits(mem.draft.journal, edits) : mem.draft.journal;

      let docType = mem.lastDocType || "none";
      ({ docType, documentFields: mem.draft.documentFields } =
        coerceDocTypeForPurchase(docType, mem.draft.documentFields || {}, editedJournal, mem.rootPrompt));

      let docModel = buildDocModel(docType, mem.draft.documentFields, editedJournal);

      const validation = await runValidation({
        docType,
        journal: editedJournal,
        docModel,
        tz: "Asia/Kolkata",
        mode: "preview",
        plannedIdempotencyKey: idempotencyKey || null
      });

      const { hardErrors, mergedWarnings } = partitionValidation(validation);
      if (hardErrors.length) {
        return send(res, {
          success: false,
          status: "invalid",
          errors: hardErrors,
          warnings: mergedWarnings,
          promptType: docType
        }, { debug });
      }

      const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
      const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp" });

      const previewPayload = {
        docType,
        docModel: { ...docModel, number: reservation.number },
        journal: editedJournal
      };

      const snap = await createSnapshot({
        docType,
        payload: previewPayload,
        reservation,
        sessionId,
        userId: req.body?.userId || null
      });

      mem.draft.journal = editedJournal;
      mem.lastStatus = "preview";
      mem.updatedAt = Date.now();

      const ledgerView = buildLedgerView(editedJournal);

      return send(res, {
        success: true,
        status: "preview",
        previewId: snap.previewId,
        hash: snap.hash,
        expiresAt: snap.expiresAt,
        promptType: docType,
        journal: editedJournal,
        ledgerView,
        explanation: "Review and confirm the journal.",
        newAccounts: extractNewAccountsFromValidation(validation),
        warnings: mergedWarnings,
        docType,
        documentFields: mem.draft.documentFields || {},
      }, { debug });
    }

    /* ---------- NL FLOW (chat) ---------- */
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      return res.status(400).json({
        success: false,
        status: "error",
        message: "Prompt cannot be empty (or provide 'edits' for preview re-render)."
      });
    }

    if (mem.rootPrompt === null) {
      mem.rootPrompt = prompt.trim();
      mem.answers = [];
      mem.clarifications = [];
      mem.lastStatus = "pending";
      mem.lastDocType = null;
      mem.draft = { documentFields: null, journal: null };
    } else {
      mem.answers.push(prompt.trim());
    }
    mem.updatedAt = Date.now();

    const combinedPrompt = buildCombinedPrompt(mem);

    const cls = await classifyPromptType({
      currentPrompt: combinedPrompt,
      previousFollowUpChain: mem.clarifications,
      parsedDocType,
      parsedFields
    });

    if (cls.flow === "ignore_outbound") {
      mem.lastStatus = "followup_needed";
      return send(res, {
        success: true,
        status: "followup_needed",
        clarification:
          "This appears to be an outbound document issued by your own business. The upload parser handles inbound docs only.",
        docType: "none",
        promptType: "none",
        classifier: cls
      }, { debug });
    }

    const docTypeHint = chooseDocTypeHint(cls, parsedDocType);
    const strongSignals = deriveSignalsFromParsed(cls.flow, parsedDocType, parsedFields, cls.signals);
    const accountantPrompt = buildCanonicalPromptFromSignals(docTypeHint, strongSignals, combinedPrompt);

    const inferred = await inferJournalEntriesFromPrompt(accountantPrompt, docTypeHint);
    const finalJournal = enforceAll(inferred?.journal || [], parsedFields, combinedPrompt || "");

    if (inferred && inferred.status === "followup_needed") {
      const question = inferred.clarification || "Please provide the missing detail.";
      mem.clarifications.push(question);
      mem.lastStatus = "followup_needed";
      mem.lastDocType = inferred.docType || mem.lastDocType || "none";
      mem.updatedAt = Date.now();

      return send(res, {
        success: true,
        status: "followup_needed",
        clarification: question,
        docType: mem.lastDocType || "none",
        promptType: docTypeHint || null,
        classifier: cls,
        fallbackUsed: inferred.fallbackUsed,
        chosenDocTypeHint: docTypeHint
      }, { debug });
    }

    if (!inferred || inferred.status !== "success" || !Array.isArray(finalJournal)) {
      mem.lastStatus = "invalid";
      mem.updatedAt = Date.now();
      return send(res, {
        success: false,
        status: inferred?.status || "invalid",
        error: inferred?.message || "Could not infer a valid journal from the prompt.",
        promptType: docTypeHint || null,
        classifier: cls,
        fallbackUsed: inferred?.fallbackUsed,
        chosenDocTypeHint: docTypeHint
      }, { debug });
    }

    let docType = (inferred && typeof inferred.docType === "string") ? inferred.docType : "none";
    let documentFields =
      (inferred && inferred.documentFields && typeof inferred.documentFields === "object")
        ? inferred.documentFields
        : {};

    ({ docType, documentFields } =
      coerceDocTypeForPurchase(docType, documentFields, finalJournal, mem.rootPrompt || prompt));

    const docModel = buildDocModel(docType, documentFields, finalJournal);

    const validation = await runValidation({
      docType,
      journal: finalJournal,
      docModel,
      tz: "Asia/Kolkata",
      mode: "preview",
      plannedIdempotencyKey: idempotencyKey || null
    });

    const { hardErrors, mergedWarnings } = partitionValidation(validation);
    if (hardErrors.length) {
      mem.lastStatus = "invalid";
      mem.updatedAt = Date.now();
      return send(res, {
        success: false,
        status: "invalid",
        errors: hardErrors,
        warnings: mergedWarnings,
        promptType: docTypeHint || null
      }, { debug });
    }

    const dateISO = docModel?.date || new Date().toISOString().slice(0, 10);
    const reservation = await reserveSeries({ docType, dateISO, previewId: "tmp" });

    const previewPayload = {
      docType,
      docModel: { ...docModel, number: reservation.number },
      journal: finalJournal
    };

    const snap = await createSnapshot({
      docType,
      payload: previewPayload,
      reservation,
      sessionId,
      userId: req.body?.userId || null
    });

    const ledgerView = buildLedgerView(finalJournal);

    mem.lastStatus = "preview";
    mem.lastDocType = docType || mem.lastDocType || "none";
    mem.draft = { documentFields, journal: finalJournal };
    mem.updatedAt = Date.now();

    return send(res, {
      success: true,
      status: "preview",
      previewId: snap.previewId,
      hash: snap.hash,
      expiresAt: snap.expiresAt,
      promptType: docTypeHint || null,
      journal: finalJournal,
      ledgerView,
      explanation: inferred.explanation || "Review and confirm the journal.",
      newAccounts: extractNewAccountsFromValidation(validation),
      warnings: mergedWarnings,
      docType: mem.lastDocType || "none",
      documentFields: mem.draft.documentFields || {},
      classifier: cls,
      chosenDocTypeHint: docTypeHint
    }, { debug });

  } catch (err) {
    console.error("🚨 Orchestration Error:", err);
    const sid = (req.body && req.body.sessionId) || "default-session";
    getMem(sid).lastStatus = "error";
    return res.status(500).json({ success: false, status: "error", message: "Internal server error during orchestration." });
  }
};
