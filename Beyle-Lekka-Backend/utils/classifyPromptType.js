// utils/classifyPromptType.js
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Keep original label set
const VALID_RESULTS = ["followup", "invoice", "receipt", "voucher", "new", "uncertain"];

const TODAY = new Date().toISOString().slice(0, 10);
const ORG_NAME  = (process.env.ORG_NAME  || "").toLowerCase().trim();
const ORG_GSTIN = (process.env.ORG_GSTIN || "").toLowerCase().trim();

/* -------------------- CONTRA DETECTOR -------------------- */
const CONTRA_WITHDRAW_RE = /(withdraw|withdrew|drawn)\s+cash|cash\s*withdrawal|petty\s*cash/i;
const CONTRA_DEPOSIT_RE  = /(deposit|deposited)\s+cash|cash\s+deposit|cash\s+to\s+bank/i;

function detectContraFromText(s) {
  const t = String(s || "").toLowerCase();
  if (!t) return "NONE";
  if (CONTRA_WITHDRAW_RE.test(t)) return "BANK_TO_CASH";
  if (CONTRA_DEPOSIT_RE.test(t))  return "CASH_TO_BANK";
  return "NONE";
}

/* -------------------- SYSTEM PROMPT -------------------- */
const SYSTEM = `
You are a flow classifier inside an accounting system. Classify the user's intent AND suggest the right downstream flow.
Inbound-only policy: this pipeline does NOT create outbound sales invoices. If content looks like our own sales invoice, treat it as "ignore_outbound".

Return ONLY JSON with:
{
  "status": "success" | "followup_needed",
  "type": "followup|invoice|receipt|voucher|new|uncertain",
  "flow": "payment_voucher|receipt|vendor_credit|contra|ignore_outbound|none",
  "doc_semantic_type": "vendor_invoice|receipt|delivery_note|contra_voucher|own_sales_invoice|unknown",
  "confidence": 0..1,
  "clarification": "...", // when followup_needed
  "signals": {
    "date": "YYYY-MM-DD",
    "amount": number,
    "payment_mode": string,
    "payee": string,
    "vendor": string,
    "received_from": string,
    "invoice_number": string,
    "paid": boolean,
    "direction": "BANK_TO_CASH|CASH_TO_BANK"
  }
}

Guidance:
- Paid vendor slips / retail tax invoices → flow:"payment_voucher"; set type:"voucher".
- Money received by us → flow:"receipt"; type:"receipt".
- Unpaid vendor invoice → flow:"vendor_credit"; set type:"new" (do NOT force 'invoice' here).
- Cash ↔ Bank internal transfer (withdraw/deposit/petty-cash top-up) → flow:"contra"; type:"voucher"; doc_semantic_type:"contra_voucher".
- Outbound (our own sales invoice) → flow:"ignore_outbound" (never 'invoice').
- If the user just answers a prior question (short reply), type:"followup".
- Never invent values; only include signals you can see.
- For CONTRA: never ask for a payee/vendor/beneficiary. If anything is missing, ask only for amount/direction/bank.
`;

/* -------------------- FEW-SHOTS -------------------- */
const FEWSHOTS = [
  {
    role: "user",
    content:
`TEXT:
"Tax Invoice ... No 36112 ... Date 12-09-2025 ... Nett Amount 74.00 ... Amount paid through Google Pay"
DOC_TYPE: "vendor_invoice"
FIELDS: {"invoice_number":"36112","invoice_date":"2025-09-12","total_amount":74,"payment_mode":"Google Pay"}`
  },
  {
    role: "assistant",
    content: JSON.stringify({
      status: "success",
      type: "voucher",
      flow: "payment_voucher",
      doc_semantic_type: "vendor_invoice",
      confidence: 0.92,
      signals: {
        date: "2025-09-12",
        amount: 74,
        payment_mode: "Google Pay",
        invoice_number: "36112",
        paid: true
      }
    })
  },
  {
    role: "user",
    content:
`TEXT:
"Received rent 25,000 by bank transfer yesterday."
DOC_TYPE: ""
FIELDS: {}`
  },
  {
    role: "assistant",
    content: JSON.stringify({
      status: "success",
      type: "receipt",
      flow: "receipt",
      doc_semantic_type: "receipt",
      confidence: 0.9,
      signals: {
        date: TODAY,
        amount: 25000,
        payment_mode: "bank transfer",
        received_from: "tenant",
        paid: true
      }
    })
  },
  // Contra example
  {
    role: "user",
    content:
`TEXT:
"Withdrew cash 15,000 from bank for petty cash."
DOC_TYPE: ""
FIELDS: {}`
  },
  {
    role: "assistant",
    content: JSON.stringify({
      status: "success",
      type: "voucher",
      flow: "contra",
      doc_semantic_type: "contra_voucher",
      confidence: 0.95,
      signals: {
        amount: 15000,
        direction: "BANK_TO_CASH",
        payment_mode: "CASH"
      }
    })
  }
];

/* -------------------- HELPERS -------------------- */
const asINR = (n) => (n == null ? "" : `₹${Number(n).toFixed(0)}`);

function normalizePaymentMode(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  if (/(upi|gpay|google\s*pay|phonepe|bhim|paytm|qr)/i.test(s)) return "UPI";
  if (/(neft|imps|rtgs|bank|transfer|online)/i.test(s)) return "BANK";
  if (/(card|visa|master|rupay|debit|credit)/i.test(s)) return "CARD";
  if (/cash/i.test(s)) return "CASH";
  return raw;
}

function normalizeSignals(sig = {}) {
  const out = { ...sig };

  if (typeof out.amount === "string") {
    const n = Number(String(out.amount).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) out.amount = n;
  }
  if (typeof out.date === "string" && /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(out.date)) {
    out.date = out.date.replace(/\//g, "-").slice(0, 10);
  }

  if (!out.payment_mode && out.mode) out.payment_mode = out.mode;
  if (typeof out.payment_mode === "string") out.payment_mode = normalizePaymentMode(out.payment_mode);
  if (!out.mode && out.payment_mode) out.mode = out.payment_mode;

  if (typeof out.direction === "string") {
    const d = out.direction.toUpperCase().replace(/\s+/g, "_");
    if (d === "BANK_TO_CASH" || d === "CASH_TO_BANK") out.direction = d;
  }

  return out;
}

function flowToPromptType(flow) {
  switch (flow) {
    case "payment_voucher": return "payment_voucher";
    case "receipt": return "receipt";
    case "contra": return "contra_voucher";
    default: return "none";
  }
}

export function buildCanonicalPromptFromSignals(flowOrDocHint, signals = {}, fallbackText = "") {
  const flow = String(flowOrDocHint || "").toLowerCase();
  const s = normalizeSignals(signals);
  const parts = [];

  if (flow === "payment_voucher") {
    parts.push("Paid");
    if (typeof s.amount === "number") parts.push(asINR(s.amount));
    const party = s.payee || s.vendor;
    if (party) parts.push(`to ${party}`);
    if (s.payment_mode) parts.push(`via ${s.payment_mode}`);
    if (s.date) parts.push(`on ${s.date}`);
    if (s.invoice_number) parts.push(`. Reference: vendor invoice #${s.invoice_number}`);
    parts.push(". Purpose: purchase/expense.");
    parts.push(" Use 'Bank' when payment_mode is UPI/BANK/CARD; use 'Cash' only if payment_mode is CASH.");
    return parts.join(" ").replace(/\s+\./g, ".");
  }

  if (flow === "receipt") {
    parts.push("Received");
    if (typeof s.amount === "number") parts.push(asINR(s.amount));
    if (s.received_from) parts.push(`from ${s.received_from}`);
    if (s.payment_mode) parts.push(`via ${s.payment_mode}`);
    if (s.date) parts.push(`on ${s.date}`);
    parts.push(".");
    return parts.join(" ").replace(/\s+\./g, ".");
  }

  if (flow === "contra_voucher" || flow === "contra") {
    const direction = s.direction || "BANK_TO_CASH";
    const date = s.date || null;
    const amount = s.amount ?? null;

    return [
      "You are an accountant generating a CONTRA (bank↔cash) entry.",
      "Rules:",
      " - This is an internal transfer. Do NOT include any external party/payee/vendor.",
      " - Output exactly two lines: one Bank, one Cash, opposite sides, same amount.",
      " - If amount or direction is missing, ask ONE concise clarification.",
      " - Do NOT ask for payee/vendor under any circumstances.",
      "",
      "Return a JSON object with:",
      " {",
      '   "status": "success" | "followup_needed",',
      '   "docType": "contra_voucher",',
      '   "journal": [ {account, debit, credit, date?}, {account, debit, credit, date?} ],',
      '   "documentFields": { "contra_voucher": { "date": "YYYY-MM-DD", "amount": number, "direction": "BANK_TO_CASH|CASH_TO_BANK" } },',
      '   "clarification": "..." // when status = followup_needed',
      " }",
      "",
      "Signals (safe to use):",
      JSON.stringify({ direction, date, amount }),
      "",
      "Context (names only, ignore numbers in here):",
      String(fallbackText || "")
    ].join("\n");
  }

  if (flow === "vendor_credit") {
    const inv = s.invoice_number ? ` #${s.invoice_number}` : "";
    return `Unpaid vendor invoice${inv}. Please record as a vendor payable (no cash outflow yet).`;
  }

  return fallbackText || "";
}

/* -------------------- MAIN -------------------- */
export const classifyPromptType = async (arg1, arg2) => {
  // Backward-compat shim with your existing call site
  let currentPrompt, previousFollowUpChain, parsedDocType, parsedFields;
  if (typeof arg1 === "string" || Array.isArray(arg2)) {
    currentPrompt = arg1;
    previousFollowUpChain = arg2 || [];
    parsedDocType = "";
    parsedFields = {};
  } else {
    ({ currentPrompt, previousFollowUpChain = [], parsedDocType = "", parsedFields = {} } = arg1 || {});
  }

  try {
    const lastItem = previousFollowUpChain.slice(-1)[0] || "";
    const lastClarification =
      typeof lastItem === "string" ? lastItem : (lastItem?.clarification || "");
    const wordCount = (currentPrompt || "").trim().split(/\s+/).filter(Boolean).length;

    // ---- Fast path: clear contra language → short-circuit as CONTRA
    const contraIntent = detectContraFromText(currentPrompt || "");
    if (contraIntent !== "NONE") {
      return {
        status: "success",
        type: "voucher",
        flow: "contra",
        docSemanticType: "contra_voucher",
        promptType: "contra_voucher",
        signals: normalizeSignals({ direction: contraIntent }),
        confidence: 0.98,
        clarification: ""
      };
    }

    // Build doc-aware message
    const userBlob = `
TEXT:
${currentPrompt ? JSON.stringify(currentPrompt) : '""'}

DOC_TYPE:
${parsedDocType ? JSON.stringify(parsedDocType) : '""'}

FIELDS:
${JSON.stringify(parsedFields || {})}

ORG:
- name: "${ORG_NAME || "(unknown)"}"
- gstin: "${ORG_GSTIN || "(unknown)"}"
${lastClarification ? `\nEARLIER_CLARIFICATION:\n${JSON.stringify(lastClarification)}` : "" }
`.trim();

    let candidate = null;

    /* ---- Primary: OpenAI JSON mode ---- */
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          ...FEWSHOTS,
          { role: "user", content: userBlob }
        ]
      });
      const txt = res?.choices?.[0]?.message?.content?.trim() || "";
      candidate = txt ? JSON.parse(txt) : null;
    } catch (_e) {
      // fall through to Claude if available
    }

    /* ---- Fallback: Claude tool-use (optional) ---- */
    if (!candidate && process.env.CLAUDE_API_KEY) {
      try {
        const tool = {
          name: "emit",
          input_schema: {
            type: "object",
            additionalProperties: false,
            required: ["status","type","flow","doc_semantic_type","confidence","signals"],
            properties: {
              status: { type: "string", enum: ["success","followup_needed"] },
              type:   { type: "string", enum: VALID_RESULTS },
              flow:   { type: "string", enum: ["payment_voucher","receipt","vendor_credit","contra","ignore_outbound","none"] },
              doc_semantic_type: { type: "string", enum: ["vendor_invoice","receipt","delivery_note","contra_voucher","own_sales_invoice","unknown"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              clarification: { type: "string" },
              signals: {
                type: "object",
                additionalProperties: false,
                properties: {
                  date: { type: "string" },
                  amount: { type: "number" },
                  payment_mode: { type: "string" },
                  payee: { type: "string" },
                  vendor: { type: "string" },
                  received_from: { type: "string" },
                  invoice_number: { type: "string" },
                  paid: { type: "boolean" },
                  direction: { type: "string", enum: ["BANK_TO_CASH","CASH_TO_BANK"] }
                }
              }
            }
          }
        };

        const claudeRes = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-3-opus-20240229",
            max_tokens: 300,
            temperature: 0,
            system: SYSTEM,
            messages: [...FEWSHOTS, { role: "user", content: userBlob }],
            tools: [tool],
            tool_choice: { type: "tool", name: "emit" }
          },
          {
            headers: {
              "x-api-key": process.env.CLAUDE_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            }
          }
        );

        const blocks = claudeRes?.data?.content || [];
        const toolUse = blocks.find(b => b?.type === "tool_use" && b?.name === "emit");
        if (toolUse?.input) candidate = toolUse.input;
      } catch (_e) {
        // still no candidate → go heuristic
      }
    }

    /* ---- Heuristic fail-safe (very conservative) ---- */
    if (!candidate) {
      const txt = (currentPrompt || "").toLowerCase();
      const fields = parsedFields || {};
      let type = "uncertain";
      let flow = "none";
      let doc  = "unknown";

      // Heuristic contra check (second chance)
      const hContra = detectContraFromText(txt);
      if (hContra !== "NONE") {
        return {
          type: "voucher",
          promptType: "contra_voucher",
          flow: "contra",
          docSemanticType: "contra_voucher",
          signals: normalizeSignals({ direction: hContra }),
          confidence: 0.7,
          clarification: ""
        };
      }

      if (parsedDocType) {
        const d = parsedDocType.toLowerCase();
        if (d.includes("receipt")) { type = "receipt"; flow = "receipt"; doc = "receipt"; }
        else if (d.includes("invoice")) {
          doc = "vendor_invoice";
          if ((fields.payment_mode || "").toString().trim()) { type = "voucher"; flow = "payment_voucher"; }
          else { type = "new"; flow = "vendor_credit"; }
        }
      } else if (/\breceived\b/.test(txt)) { type = "receipt"; flow = "receipt"; }
      else if (/\bpaid\b/.test(txt))     { type = "voucher"; flow = "payment_voucher"; }

      return {
        type,
        promptType: flowToPromptType(flow),
        flow,
        docSemanticType: doc,
        signals: {},
        confidence: 0.35,
        clarification: (type === "uncertain" && lastClarification) ? lastClarification : ""
      };
    }

    /* ---- Normalize + guards ---- */
    const status = String(candidate.status || "success");
    const docSemanticType = String(candidate.doc_semantic_type || "unknown");
    let flow  = String(candidate.flow || "none");
    let type  = String(candidate.type || "uncertain").toLowerCase();
    const signals = normalizeSignals(candidate.signals || {});
    const confidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 0;

    if (docSemanticType === "own_sales_invoice") {
      flow = "ignore_outbound";
      type = "uncertain";
    }

    if (!VALID_RESULTS.includes(type)) {
      type = flow === "payment_voucher" ? "voucher"
           : flow === "receipt"         ? "receipt"
           : flow === "vendor_credit"   ? "new"
           : (status === "followup_needed" ? "followup" : "uncertain");
    }

    // Use the earlier wordCount; do NOT redeclare it here
    const shortReply = (type === "uncertain" && wordCount <= 10 && lastClarification);
    if (shortReply) type = "followup";

    return {
      type,
      promptType: flowToPromptType(flow),
      flow,
      docSemanticType,
      signals,
      confidence,
      clarification: candidate.clarification || ""
    };
  } catch (err) {
    console.error("classifyPromptType error:", err?.message || err);
    return {
      type: "uncertain",
      promptType: "none",
      flow: "none",
      docSemanticType: "unknown",
      signals: {},
      confidence: 0,
      clarification: ""
    };
  }
};
