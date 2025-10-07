import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Placeholder currency symbol (session-based upgrade later if needed)
const currencySymbol = "₹";

const today = new Date().toISOString().split("T")[0]; // e.g., 2025-06-07

/* ============================================================================================
   Family-code mapping (catalog-free rails) — preferred output shape
   ============================================================================================ */
const ALLOWED_FAMILY_CODES = [
  "assets.bank",
  "assets.cash",
  "assets.receivables",
  "assets.prepaid",
  "assets.inventory",
  "assets.fixed",
  "assets.contra.accum_depr",
  "liabilities.payables",
  "liabilities.customer_advances",
  "liabilities.loans",
  "equity.capital",
  "equity.retained",
  "income.sales",
  "income.other",
  "income.contra.sales_returns",
  "income.contra.discounts_allowed",
  "expense.cogs",
  "expense.operating",
  "expense.depreciation",
  "expense.bank_charges",
  "expense.gateway_fees",
  "tax.gst.input",
  "tax.gst.output",
  "tax.tds.receivable"
];

/* ============================================================================================
   SYSTEM INSTRUCTIONS
   - Inbound-only; strict JSON; family-code mapping preferred with a safe legacy fallback.
   ============================================================================================ */
const SYSTEM_INSTRUCTIONS = `
Assume today's system date is ${today}. Convert relative or partial dates like "yesterday", "6th June", or "today" into full YYYY-MM-DD using this reference date.

You are the in-house accountant assisting the user in maintaining the financial books of their own business (any legal entity). Classify and post double-entry journals that comply with Indian Accounting Standards (Ind AS) and universally accepted accounting heads.

INBOUND-ONLY SCOPE:
- Supported doc types (inbound): "invoice" (vendor/purchase only), "receipt" (money we received from others), "payment_voucher" (our outward payment). If none applies, use "none".
- DO NOT create outbound docs (our own sales invoice/outbound delivery notes). If the prompt is outbound, set docType:"none" and ask a single clarifying question if needed.

STRICT RULES:
1) Return structured data only. Never include chain-of-thought or any commentary outside the JSON fields.
2) Never invent unknown values. If a critical detail is missing or ambiguous (date, amount, counterparty/buyer/receivedFrom, payment mode, invoice items), return status "followup_needed" with ONE concise clarification instead of posting a journal.
   Exception: For everyday expenses (electricity, water, telecom, internet, fuel, petrol/diesel, tolls, parking, subscriptions, bank charges, petty cash, ride-hailing), if the user gives date+amount+mode and no payee, DO NOT ask "paid who?" — leave payee empty and proceed.
3) For any posted journal:
   - Each line must have: date (YYYY-MM-DD), either debit>0 XOR credit>0 (not both), and non-empty account or mapping.
   - Zero-value lines are not allowed. Totals must balance to two decimals.
4) Do not assume default cash/bank/vendor/customer; infer only if explicit.

PREFERRED RESPONSE (FAMILY-CODE MAPPING):
- Use a small, universal "family_code" enumeration to classify each line.
- Allowed family_code values (choose from this list ONLY): ${ALLOWED_FAMILY_CODES.join(", ")}.
- For each line, provide mapping { family_code, parent_display, child_display, type, normal_balance } and optional tax { kind, rate } and a short "rationale".
- Do NOT invent new families. If you are unsure between two families, ask ONE concise clarification (status "followup_needed").

LEGACY FALLBACK (when mapping is not feasible):
- Return a balanced journal as an array of lines with {account,debit,credit,date[,narration]}.

DOCUMENT FIELDS:
- Always include "docType": one of {"invoice","receipt","payment_voucher","none"}.
- For "invoice" (vendor), capture: buyer, date (YYYY-MM-DD), items[{name,qty,rate,amount(optional)}], paymentMode, taxes(optional), narration(optional), totalAmount(optional).
- For "receipt": receivedFrom, amount, date (YYYY-MM-DD), mode, towards(optional), narration(optional).
- For "payment_voucher": amount, date (YYYY-MM-DD), mode, payee(optional), purpose(optional), narration(optional).

IMPORTANT:
- Output ONLY JSON matching the tool schema. No markdown fences. No prose outside the JSON.
`;

/* ============================================================================================
   TOOL SCHEMAS
   - Mapping-first tool (preferred)
   - Legacy tool (existing shape)
   ============================================================================================ */

// Family-mapping (preferred) schema
const MAPPING_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["success", "followup_needed"] },
    // When status === "success" (mapping shape)
    journal: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        currency: { type: "string", default: "INR" },
        lines: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              narration: { type: "string" },
              amount: { type: "number", minimum: 0 },
              direction: { type: "string", enum: ["debit", "credit"] },
              date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              mapping: {
                type: "object",
                additionalProperties: false,
                required: ["family_code"],
                properties: {
                  family_code: { type: "string", enum: ALLOWED_FAMILY_CODES },
                  parent_display: { type: ["string", "null"] },
                  child_display: { type: ["string", "null"] },
                  type: { type: ["string", "null"], enum: [null,"asset","liability","equity","income","expense","contra_asset","contra_income"] },
                  normal_balance: { type: ["string", "null"], enum: [null,"debit","credit"] }
                }
              },
              tax: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["none","gst_input","gst_output","rcm"] },
                  rate: { type: "number", minimum: 0 }
                },
                required: ["kind","rate"]
              },
              rationale: { type: "string" }
            },
            required: ["amount","direction","mapping","date"]
          }
        }
      },
      required: ["date", "lines"]
    },
    explanation: { type: "string" },
    docType: { type: "string", enum: ["invoice","receipt","payment_voucher","none"] },
    documentFields: {
      type: "object",
      additionalProperties: false,
      properties: {
        invoice: {
          type: "object",
          additionalProperties: false,
          required: ["buyer","date","items","paymentMode"],
          properties: {
            buyer: { type: "string", minLength: 1 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name","qty","rate"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  qty: { type: "number", minimum: 0 },
                  rate: { type: "number", minimum: 0 },
                  amount: { type: "number", minimum: 0 }
                }
              }
            },
            paymentMode: { type: "string", minLength: 1 },
            taxes: { type: "number" },
            narration: { type: "string" },
            totalAmount: { type: "number" }
          }
        },
        receipt: {
          type: "object",
          additionalProperties: false,
          required: ["receivedFrom","amount","date","mode"],
          properties: {
            receivedFrom: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            mode: { type: "string", minLength: 1 },
            towards: { type: "string" },
            narration: { type: "string" }
          }
        },
        payment_voucher: {
          type: "object",
          additionalProperties: false,
          required: ["amount","date","mode"],
          properties: {
            payee: { type: "string" },
            amount: { type: "number", minimum: 0 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            mode: { type: "string", minLength: 1 },
            purpose: { type: "string" },
            narration: { type: "string" }
          }
        }
      }
    },
    // When status === "followup_needed"
    clarification: { type: "string" }
  },
  required: ["status","docType"]
};

// Legacy output schema (your current shape)
const LEGACY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["success", "followup_needed"] },
    journal: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["account", "debit", "credit", "date"],
        properties: {
          account: { type: "string", minLength: 1, maxLength: 128 },
          debit: { type: "number", minimum: 0 },
          credit: { type: "number", minimum: 0 },
          narration: { type: "string", maxLength: 512 },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
        }
      }
    },
    explanation: { type: "string" },
    docType: { type: "string", enum: ["invoice", "receipt", "payment_voucher", "none"] },
    documentFields: {
      type: "object",
      additionalProperties: false,
      properties: {
        invoice: {
          type: "object",
          additionalProperties: false,
          required: ["buyer","date","items","paymentMode"],
          properties: {
            buyer: { type: "string", minLength: 1 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name","qty","rate"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  qty: { type: "number", minimum: 0 },
                  rate: { type: "number", minimum: 0 },
                  amount: { type: "number", minimum: 0 }
                }
              }
            },
            paymentMode: { type: "string", minLength: 1 },
            taxes: { type: "number" },
            narration: { type: "string" },
            totalAmount: { type: "number" }
          }
        },
        receipt: {
          type: "object",
          additionalProperties: false,
          required: ["receivedFrom","amount","date","mode"],
          properties: {
            receivedFrom: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            mode: { type: "string", minLength: 1 },
            towards: { type: "string" },
            narration: { type: "string" }
          }
        },
        payment_voucher: {
          type: "object",
          additionalProperties: false,
          required: ["amount","date","mode"],
          properties: {
            payee: { type: "string", minLength: 1 },
            amount: { type: "number", minimum: 0 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            mode: { type: "string", minLength: 1 },
            purpose: { type: "string" },
            narration: { type: "string" }
          }
        }
      }
    },
    clarification: { type: "string" }
  },
  required: ["status","docType"]
};

/* ============================================================================================
   Helpers (legacy normalization used only for legacy fallback)
   ============================================================================================ */
const isYYYYMMDD = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const toCents = (n) => {
  if (typeof n === "string") {
    const cleaned = n.replace(/[^\d.-]/g, "");
    const parsed = Number.parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
  }
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

const twoDp = (n) => Math.round(n * 100) / 100;

function normalizeJournal(journal) {
  if (!Array.isArray(journal)) return { ok: false, errors: ["journal:not_array"] };

  const normalized = [];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < journal.length; i++) {
    const row = journal[i] || {};
    const account = String(row.account || "").trim().replace(/\s+/g, " ");
    const date = String(row.date || "").trim();

    const debitC = toCents(row.debit);
    const creditC = toCents(row.credit);

    if (!account) errors.push(`row${i + 1}:account_missing`);
    if (!isYYYYMMDD(date)) errors.push(`row${i + 1}:date_invalid`);

    if (debitC === null || debitC < 0) errors.push(`row${i + 1}:debit_invalid`);
    if (creditC === null || creditC < 0) errors.push(`row${i + 1}:credit_invalid`);

    if (debitC > 0 && creditC > 0) errors.push(`row${i + 1}:both_debit_credit_positive`);
    if (debitC === 0 && creditC === 0) errors.push(`row${i + 1}:both_zero`);

    const narr = (row.narration || "").toString().trim();
    normalized.push({
      account,
      debit: twoDp((debitC || 0) / 100),
      credit: twoDp((creditC || 0) / 100),
      narration: narr,
      date
    });
  }

  if (normalized.length < 2) errors.push("journal:min_2_lines");

  const totalDebitCents = normalized.reduce((s, r) => s + toCents(r.debit), 0);
  const totalCreditCents = normalized.reduce((s, r) => s + toCents(r.credit), 0);
  if (totalDebitCents !== totalCreditCents) {
    errors.push(`journal:not_balanced:${(totalDebitCents / 100).toFixed(2)}!=${(totalCreditCents / 100).toFixed(2)}`);
  }

  return { ok: errors.length === 0, errors, warnings, normalized };
}

/* ============================================================================================
   Utilities
   ============================================================================================ */
function pickMappingToolUse(blocks) {
  return (blocks || []).find((b) => b?.type === "tool_use" && b?.name === "produce_family_mapping");
}
function pickLegacyToolUse(blocks) {
  return (blocks || []).find((b) => b?.type === "tool_use" && b?.name === "produce_legacy_output");
}
function looksLikeFamilyPayload(candidate) {
  return candidate && candidate.journal && Array.isArray(candidate.journal.lines);
}

/* ============================================================================================
   Main: Inference with mapping-first, safe legacy fallback
   ============================================================================================ */
export const inferJournalEntriesFromPrompt = async (userPrompt, promptType = "") => {
  let usedFallback = null;

  const fullPrompt = `
User Prompt:
"""${userPrompt}"""

Caller Hint (may be empty): docType="${promptType || "none"}"

TASK:
1) Prefer FAMILY-CODE mapping output. If you can classify lines into families confidently, return the mapping shape.
2) If any critical detail is missing/ambiguous (date, amount, counterparty, payment mode, invoice items), return status "followup_needed" with ONE concise clarification and, if known, the inferred docType.
3) If mapping is not feasible, return the legacy balanced journal shape. 
`.trim();

  console.log("Running inference → Claude mapping-first (tool/schema), legacy Claude fallback, GPT JSON fallback, OpenRouter fallback");

  /* ---------- Claude PRIMARY: mapping-first (forced mapping tool) ---------- */
  const claudeMappingPromise = axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: process.env.CLAUDE_MODEL || "claude-3-opus-20240229",
      max_tokens: 1200,
      temperature: 0,
      system: SYSTEM_INSTRUCTIONS,
      messages: [{ role: "user", content: fullPrompt }],
      tools: [
        {
          name: "produce_family_mapping",
          description: "Return ONLY structured output matching the mapping schema. Prefer this when feasible.",
          input_schema: MAPPING_OUTPUT_SCHEMA
        },
        {
          name: "produce_legacy_output",
          description: "Return ONLY structured output matching the legacy schema (use only if mapping cannot be done).",
          input_schema: LEGACY_OUTPUT_SCHEMA
        }
      ],
      tool_choice: { type: "tool", name: "produce_family_mapping" }
    },
    {
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      }
    }
  );

  // If mapping fails or not provided, we call legacy tool explicitly.
  const callClaudeLegacy = async () => {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: process.env.CLAUDE_MODEL || "claude-3-opus-20240229",
          max_tokens: 1000,
          temperature: 0,
          system: SYSTEM_INSTRUCTIONS,
          messages: [{ role: "user", content: fullPrompt }],
          tools: [
            { name: "produce_legacy_output", description: "Legacy journal output.", input_schema: LEGACY_OUTPUT_SCHEMA }
          ],
          tool_choice: { type: "tool", name: "produce_legacy_output" }
        },
        {
          headers: {
            "x-api-key": process.env.CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          }
        }
      );
      const blocks = res?.data?.content || [];
      const tu = pickLegacyToolUse(blocks);
      if (tu?.input) return tu.input;
      return null;
    } catch (err) {
      console.error("Claude legacy call failed:", err?.message || err);
      return null;
    }
  };

  // ---------- OpenAI GPT FALLBACK (JSON mode) ----------
  const gptPromise = openai.chat.completions.create({
    model: process.env.OPENAI_FALLBACK_MODEL || "gpt-4-1106-preview",
    temperature: 0,
    top_p: 1,
    seed: 42,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      {
        role: "user",
        content:
          `${fullPrompt}\n\n` +
          `Prefer the mapping shape. If not feasible, return legacy.\n` +
          `Return ONLY a JSON object with:\n` +
          `- status ("success"|"followup_needed")\n` +
          `- EITHER journal:{date,currency,lines:[{narration,amount,direction,date,mapping:{family_code,parent_display,child_display,type,normal_balance},tax:{kind,rate},rationale}...]}\n` +
          `- OR journal:[{account,debit,credit,date(,narration)}...]\n` +
          `- explanation (if success)\n` +
          `- docType\n` +
          `- documentFields keyed by docType\n` +
          `- clarification (if followup_needed)`
      }
    ]
  });

  // ---------- OpenRouter secondary fallback (plain JSON string) ----------
  const getOpenRouterFallback = async () => {
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: process.env.OPENROUTER_MODEL || "mistral/mixtral-8x7b-instruct",
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTIONS },
            {
              role: "user",
              content:
                `${fullPrompt}\n\n` +
                `Prefer mapping; else legacy. Return ONLY a JSON object, no markdown fences.`
            }
          ],
          temperature: 0
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
      return res.data.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("OpenRouter failed:", err.message);
      return "";
    }
  };

  try {
    const claudeRes = await claudeMappingPromise;

    let candidate = null;

    // 1) Try Claude mapping tool_use first
    const blocks = claudeRes?.data?.content || [];
    const mapTU = pickMappingToolUse(blocks);
    if (mapTU?.input) {
      candidate = mapTU.input;
      console.log("Claude mapping JSON received.");
    } else {
      console.warn("Claude mapping fulfilled but no mapping tool_use; trying Claude legacy tool.");
      candidate = await callClaudeLegacy();
      if (candidate) {
        usedFallback = "claude_legacy";
        console.log("Claude legacy JSON received.");
      }
    }

    // 2) If no Claude result, try GPT
    if (!candidate) {
      const gptRes = await gptPromise;
      try {
        const txt = gptRes?.choices?.[0]?.message?.content?.trim() || "";
        candidate = txt ? JSON.parse(txt) : null;
        usedFallback = "gpt";
        console.log("GPT (JSON mode) JSON received.");
      } catch (e) {
        console.warn("GPT JSON parse failed:", e.message);
      }
    }

    // 3) If still nothing, try OpenRouter (parse JSON from text)
    if (!candidate) {
      const openRouterRaw = await getOpenRouterFallback();
      if (openRouterRaw) {
        usedFallback = "openrouter";
        let cleaned = openRouterRaw.replace(/```json/gi, "").replace(/```/g, "");
        const match = cleaned.match(/\{[\s\S]*\}$/);
        const jsonRaw = match ? match[0] : cleaned;
        try {
          candidate = JSON.parse(jsonRaw);
          console.log("OpenRouter JSON parsed.");
        } catch {
          console.warn("OpenRouter JSON parse failed.");
        }
      }
    }

    if (!candidate) {
      throw new Error("All models failed to produce structured JSON.");
    }

    // FOLLOWUP path (both mapping & legacy)
    if (String(candidate.status).toLowerCase() === "followup_needed") {
      const clarification =
        (typeof candidate.clarification === "string" && candidate.clarification.trim()) ||
        "Please provide the missing date, amount, counterparty/buyer/receivedFrom, payment mode, or invoice items.";
      const docType =
        (typeof candidate.docType === "string" && ["invoice","receipt","payment_voucher","none"].includes(candidate.docType))
          ? candidate.docType
          : (promptType && ["invoice","receipt","payment_voucher"].includes(promptType) ? promptType : "none");

      return {
        status: "followup_needed",
        clarification,
        docType,
        fallbackUsed: usedFallback
      };
    }

    // SUCCESS path
    // If it's mapping shape, return as-is (or with minimal cleanup).
    if (looksLikeFamilyPayload(candidate)) {
      // Ensure minimal fields exist
      const explanation =
        (typeof candidate.explanation === "string" && candidate.explanation.trim()) ||
        "Mapped each line to a standard family; debits and credits balance.";
      let docType = (typeof candidate.docType === "string" && ["invoice","receipt","payment_voucher","none"].includes(candidate.docType))
        ? candidate.docType
        : (["invoice","receipt","payment_voucher"].includes(promptType) ? promptType : "none");

      const documentFields =
        candidate && candidate.documentFields && typeof candidate.documentFields === "object"
          ? candidate.documentFields
          : {};

      // Do not touch candidate.journal.lines; orchestrator will validate, normalize and explain.
      return {
        status: "success",
        journal: candidate.journal,   // { date, currency, lines: [...] with mapping }
        explanation,
        docType,
        documentFields,
        fallbackUsed: usedFallback
      };
    }

    // Else, handle legacy shape: normalize & return legacy result
    const rawJournal = Array.isArray(candidate.journal) ? candidate.journal : [];
    const norm = normalizeJournal(rawJournal);
    if (!norm.ok) {
      return {
        status: "fallback_to_manual",
        message: `Invalid journal entry: ${norm.errors.join(", ")}`,
        fallbackUsed: usedFallback,
        rawOutput: candidate
      };
    }

    let docType = (typeof candidate.docType === "string" && ["invoice","receipt","payment_voucher","none"].includes(candidate.docType))
      ? candidate.docType
      : "none";
    if (docType === "none" && ["invoice","receipt","payment_voucher"].includes(promptType)) {
      docType = promptType;
    }

    const documentFields =
      candidate && candidate.documentFields && typeof candidate.documentFields === "object"
        ? candidate.documentFields
        : {};

    const explanation =
      (typeof candidate.explanation === "string" && candidate.explanation.trim()) ||
      "Transaction recorded as a balanced double-entry.";

    return {
      status: "success",
      journal: norm.normalized, // legacy shape; orchestrator handles this path too
      explanation,
      docType,
      documentFields,
      fallbackUsed: usedFallback
    };
  } catch (err) {
    console.error("Parsing/validation failed:", err.message);
    return {
      status: "fallback_to_manual",
      message: "Could not parse a valid accounting output.",
      fallbackUsed: usedFallback,
      rawOutput: null
    };
  }
};
