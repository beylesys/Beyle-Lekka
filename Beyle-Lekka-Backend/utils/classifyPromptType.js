// utils/classifyPromptType.js
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Your original label set remains intact
const VALID_RESULTS = ["followup", "invoice", "receipt", "voucher", "new", "uncertain"];

const TODAY = new Date().toISOString().slice(0, 10);
const ORG_NAME  = (process.env.ORG_NAME  || "").toLowerCase().trim();
const ORG_GSTIN = (process.env.ORG_GSTIN || "").toLowerCase().trim();

/* -------------------- SYSTEM PROMPT -------------------- */
const SYSTEM = `
You are a flow classifier inside an accounting system. Classify the user's intent AND suggest the right downstream flow.
Inbound-only policy: this pipeline does NOT create outbound sales invoices. If content looks like our own sales invoice, treat it as "ignore_outbound".

Return ONLY JSON with:
{
  "status": "success" | "followup_needed",
  "type": "followup|invoice|receipt|voucher|new|uncertain",
  "flow": "payment_voucher|receipt|vendor_credit|ignore_outbound|none",
  "doc_semantic_type": "vendor_invoice|receipt|delivery_note|own_sales_invoice|unknown",
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
    "paid": boolean
  }
}

Guidance:
- Paid vendor slips / retail tax invoices → flow:"payment_voucher"; set type:"voucher".
- Money received by us → flow:"receipt"; type:"receipt".
- Unpaid vendor invoice → flow:"vendor_credit"; set type:"new" (do NOT force 'invoice' here).
- Outbound (our own sales invoice) → flow:"ignore_outbound" (never 'invoice').
- If the user just answers a prior question (short reply), type:"followup".
- Never invent values; only include signals you can see.
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
  return raw; // leave as-is if unrecognized
}

function normalizeSignals(sig = {}) {
  const out = { ...sig };

  // amount/date normalization
  if (typeof out.amount === "string") {
    const n = Number(String(out.amount).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) out.amount = n;
  }
  if (typeof out.date === "string" && /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(out.date)) {
    out.date = out.date.replace(/\//g, "-").slice(0, 10);
  }

  // 🔐 bridge & normalize payment channel (critical for production accuracy)
  if (!out.payment_mode && out.mode) out.payment_mode = out.mode;
  if (typeof out.payment_mode === "string") {
    out.payment_mode = normalizePaymentMode(out.payment_mode);
  }
  // keep symmetric alias for downstream code that might read `mode`
  if (!out.mode && out.payment_mode) out.mode = out.payment_mode;

  return out;
}

function flowToPromptType(flow) {
  switch (flow) {
    case "payment_voucher": return "payment_voucher";
    case "receipt": return "receipt";
    default: return "none";
  }
}

export function buildCanonicalPromptFromSignals(flow, signals = {}, fallbackText = "") {
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
    // 👇 Nudge model away from 'Cash' unless payment_mode explicitly says CASH
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

    // Build doc-aware message to keep the classifier context-rich
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
              flow:   { type: "string", enum: ["payment_voucher","receipt","vendor_credit","ignore_outbound","none"] },
              doc_semantic_type: { type: "string", enum: ["vendor_invoice","receipt","delivery_note","own_sales_invoice","unknown"] },
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
                  paid: { type: "boolean" }
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

    // Outbound docs never proceed in this inbound pipeline
    if (docSemanticType === "own_sales_invoice") {
      flow = "ignore_outbound";
      type = "uncertain";
    }

    // Ensure type conforms to your enum (map from flow if needed)
    if (!VALID_RESULTS.includes(type)) {
      type = flow === "payment_voucher" ? "voucher"
           : flow === "receipt"         ? "receipt"
           : flow === "vendor_credit"   ? "new"
           : (status === "followup_needed" ? "followup" : "uncertain");
    }

    // Short-reply override: preserve the original follow-up behavior
    const shortReply = (type === "uncertain" && wordCount <= 10 && lastClarification);
    if (shortReply) type = "followup";

    return {
      type,                                   // (unchanged) NL-JE label
      promptType: flowToPromptType(flow),     // downstream accountant prompt type
      flow,
      docSemanticType,
      signals,                                // includes normalized payment_mode/mode
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
