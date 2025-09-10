import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Placeholder currency symbol (to be upgraded with session-based value)
const currencySymbol = "₹";

const today = new Date().toISOString().split("T")[0]; // e.g., 2025-06-07

// ------------------------ SYSTEM INSTRUCTIONS (revised) ------------------------
const SYSTEM_INSTRUCTIONS = `
Assume today's system date is ${today}. Convert relative or partial dates like "yesterday", "6th June", or "today" into full YYYY-MM-DD using this reference date.

You are the in-house accountant assisting the user in maintaining the financial books of their own business (any legal entity). Classify and post double-entry journals that comply with Indian Accounting Standards (Ind AS) and universally accepted accounting heads.

You ALSO extract document fields for a business document when the prompt implies one:
- Supported doc types: "invoice", "receipt", "payment_voucher" (if none applies, use "none").
- For "invoice", capture: buyer, date (YYYY-MM-DD), items[{name, qty, rate, amount(optional)}], paymentMode, taxes(optional), narration(optional), totalAmount(optional).
- For "receipt", capture: receivedFrom, amount, date (YYYY-MM-DD), mode, towards(optional), narration(optional).
- For "payment_voucher", capture: payee, amount, date (YYYY-MM-DD), mode, purpose(optional), narration(optional).

RULES (STRICT):
1) Return structured data only. Do not include chain-of-thought, explanations, or commentary outside the structured fields.
2) Never invent unknown values. If a critical detail for JE or for the document is missing or ambiguous (date, amount, counterparty/buyer/payee/receivedFrom, payment mode, or invoice items), request ONE concise clarification instead of posting a journal.
3) Required for any posted journal:
   - Each line must include: date (YYYY-MM-DD), account (string), debit (number >= 0), credit (number >= 0).
   - For each line, exactly one of {debit, credit} must be > 0 (XOR). Zero-value lines are not allowed.
   - Total debits must equal total credits (after normalization to two decimals).
4) Do not assume default cash/bank/vendor/customer; infer from the prompt only if explicit.
5) Dates must be normalized per the system date above.
6) Output format is controlled by the caller via tool input schema (for Claude) or JSON mode (for fallbacks). Follow it exactly.

RESPONSE MODES:
- SUCCESS: Provide a balanced journal (array of lines), a short layman "explanation", the "docType", and "documentFields" for that docType (or docType:"none" with empty fields if no doc should be created).
- FOLLOWUP_NEEDED: Provide a single "clarification" string explaining precisely what is missing. If known, also return the inferred "docType".

IMPORTANT:
- Do not output anything other than the structured JSON.
`;

// ------------------------ Tool / JSON Schema used for Claude -------------------
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["success", "followup_needed"] },

    // When status === "success"
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

    // Document extraction (always include docType; use "none" when no doc should be generated)
    docType: { type: "string", enum: ["invoice", "receipt", "payment_voucher", "none"] },

    documentFields: {
      type: "object",
      additionalProperties: false,
      properties: {
        invoice: {
          type: "object",
          additionalProperties: false,
          required: ["buyer", "date", "items", "paymentMode"],
          properties: {
            buyer: { type: "string", minLength: 1 },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "qty", "rate"],
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
          required: ["receivedFrom", "amount", "date", "mode"],
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
          required: ["payee", "amount", "date", "mode"],
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

    // When status === "followup_needed"
    clarification: { type: "string" }
  },
  required: ["status", "docType"]
};

// ------------------------ Helpers: normalization & validation ------------------
const isYYYYMMDD = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const toCents = (n) => {
  if (typeof n === "string") {
    // Accept common numeric strings like "1,500.00" or "₹1,500.00"
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

  // Balance check in cents
  const totalDebitCents = normalized.reduce((s, r) => s + toCents(r.debit), 0);
  const totalCreditCents = normalized.reduce((s, r) => s + toCents(r.credit), 0);
  if (totalDebitCents !== totalCreditCents) {
    errors.push(`journal:not_balanced:${(totalDebitCents / 100).toFixed(2)}!=${(totalCreditCents / 100).toFixed(2)}`);
  }

  return { ok: errors.length === 0, errors, warnings, normalized };
}

function buildLedgerView(rows) {
  // | Date | Account | Debit | Credit | Narration |
  const header = `Date | Account | Debit | Credit | Narration`;
  const sep = `---- | ------- | ----- | ------ | ---------`;
  const lines = rows.map(r =>
    `${r.date} | ${r.account} | ${r.debit.toFixed(2)} | ${r.credit.toFixed(2)} | ${r.narration || ""}`
  );
  return [header, sep, ...lines].join("\n");
}

// Minimal sanitizer for document fields (do NOT invent; just tidy)
function sanitizeDocumentFields(docType, documentFields) {
  if (!docType || docType === "none" || !documentFields) return {};
  const df = documentFields[docType] || null;
  if (!df) return {};

  // Compute item.amount if qty & rate present and amount missing (light-touch, not invention)
  if (docType === "invoice" && Array.isArray(df.items)) {
    df.items = df.items.map(it => {
      const out = { ...it };
      if (typeof out.amount !== "number" && typeof out.qty === "number" && typeof out.rate === "number") {
        out.amount = twoDp(out.qty * out.rate);
      }
      return out;
    });
  }

  return { [docType]: df };
}

// ------------------------ Main: Inference with guardrails ----------------------
export const inferJournalEntriesFromPrompt = async (userPrompt, promptType = "") => {
  let usedFallback = null;

  // Keep prompt simple & deterministic; all instructions live in SYSTEM_INSTRUCTIONS
  const fullPrompt = `
User Prompt:
"""${userPrompt}"""

Caller Hint (may be empty): docType="${promptType || "none"}"

TASK:
1) If all critical info for BOTH the journal and the document (if applicable) is present, output status "success" with:
   - a balanced journal
   - a short layman explanation
   - docType in {"invoice","receipt","payment_voucher","none"}
   - documentFields keyed by that docType (or empty if "none")
2) If anything critical is missing/ambiguous (date, amount, counterparty, payment mode, invoice items), output status "followup_needed" with ONE concise clarification question. If you can infer the docType from the user prompt, include that docType; otherwise "none".
`.trim();

  console.log("🧠 Running inference → Claude primary (tool/schema), GPT fallback (JSON mode), OpenRouter secondary fallback");

  // ---------- Claude PRIMARY (forced tool-use with input_schema) ----------
  const claudePromise = axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-3-opus-20240229",
      max_tokens: 1200,
      temperature: 0, // determinism
      system: SYSTEM_INSTRUCTIONS,
      messages: [{ role: "user", content: fullPrompt }],
      tools: [
        {
          name: "produce_output",
          description: "Return ONLY structured output matching the schema. Never include explanations outside the fields.",
          input_schema: OUTPUT_SCHEMA
        }
      ],
      tool_choice: { type: "tool", name: "produce_output" } // force JSON via tool
    },
    {
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      }
    }
  );

  // ---------- OpenAI FALLBACK (JSON mode + seed) ----------
  const gptPromise = openai.chat.completions.create({
    model: "gpt-4-1106-preview",
    temperature: 0,
    top_p: 1,
    seed: 42, // best-effort reproducibility
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      {
        role: "user",
        content: `${fullPrompt}\n\nReturn ONLY a JSON object with keys: status, journal (if success), explanation (if success), docType, documentFields, clarification (if followup_needed).`
      }
    ]
  });

  // ---------- OpenRouter secondary fallback (plain JSON string) ----------
  const getOpenRouterFallback = async () => {
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistral/mixtral-8x7b-instruct",
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTIONS },
            {
              role: "user",
              content:
                `${fullPrompt}\n\nReturn ONLY a JSON object with keys: status, journal (if success), explanation (if success), docType, documentFields, clarification (if followup_needed). No markdown fences.`
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
      console.error("🟥 OpenRouter failed:", err.message);
      return "";
    }
  };

  try {
    const [claudeRes, gptRes] = await Promise.allSettled([claudePromise, gptPromise]);

    // Prefer Claude tool result
    let candidate = null;

    if (claudeRes.status === "fulfilled") {
      const blocks = claudeRes.value?.data?.content || [];
      // Find the tool_use block for "produce_output"
      const toolUse = blocks.find((b) => b?.type === "tool_use" && b?.name === "produce_output");
      if (toolUse?.input) {
        candidate = toolUse.input; // already an object per input_schema
        console.log("🟣 Claude (tool) JSON received.");
      } else {
        console.warn("🟠 Claude fulfilled but no tool_use content; falling back.");
      }
    } else {
      console.error("❌ Claude error:", claudeRes.reason?.message || "unknown");
    }

    // If no Claude JSON, try OpenAI JSON mode
    if (!candidate && gptRes.status === "fulfilled") {
      try {
        const txt = gptRes.value?.choices?.[0]?.message?.content?.trim() || "";
        candidate = txt ? JSON.parse(txt) : null;
        usedFallback = "gpt";
        console.log("🔵 GPT (JSON mode) JSON received.");
      } catch (e) {
        console.warn("🟠 GPT JSON parse failed:", e.message);
      }
    } else if (!candidate && gptRes.status !== "fulfilled") {
      console.error("❌ GPT error:", gptRes.reason?.message || "unknown");
    }

    // If still nothing, use OpenRouter string and parse
    if (!candidate) {
      const openRouterRaw = await getOpenRouterFallback();
      if (openRouterRaw) {
        usedFallback = "openrouter";
        let cleaned = openRouterRaw.replace(/```json/gi, "").replace(/```/g, "");
        const match = cleaned.match(/\{[\s\S]*\}$/);
        const jsonRaw = match ? match[0] : cleaned;
        try {
          candidate = JSON.parse(jsonRaw);
          console.log("🟢 OpenRouter JSON parsed.");
        } catch (e) {
          console.warn("🟠 OpenRouter JSON parse failed.");
        }
      }
    }

    if (!candidate) {
      throw new Error("All models failed to produce structured JSON.");
    }

    // FOLLOWUP short-circuit
    if (String(candidate.status).toLowerCase() === "followup_needed") {
      const clarification =
        (candidate && typeof candidate.clarification === "string" && candidate.clarification.trim()) ||
        "Please provide the missing date, amount, counterparty/buyer/payee, payment mode, or invoice items.";
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

    // SUCCESS path: validate & normalize JE, include doc info
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

    // Derive docType with hint fallback
    let docType = (typeof candidate.docType === "string" && ["invoice","receipt","payment_voucher","none"].includes(candidate.docType))
      ? candidate.docType
      : "none";

    if (docType === "none" && ["invoice","receipt","payment_voucher"].includes(promptType)) {
      // Only bias with caller hint if the model gave "none"
      docType = promptType;
    }

    // Sanitize documentFields minimally (no invention)
    const documentFields =
      candidate && candidate.documentFields && typeof candidate.documentFields === "object"
        ? sanitizeDocumentFields(docType, candidate.documentFields)
        : {};

    // Build ledgerView from normalized rows (consistent formatting)
    const ledgerView = buildLedgerView(norm.normalized);
    const explanation =
      (typeof candidate.explanation === "string" && candidate.explanation.trim()) ||
      "Transaction recorded as a balanced double-entry.";

    return {
      status: "success",
      journal: norm.normalized,
      ledgerView,
      explanation,
      docType,                  // "invoice" | "receipt" | "payment_voucher" | "none"
      documentFields,           // { invoice|receipt|payment_voucher: {...} } or {}
      fallbackUsed: usedFallback
    };
  } catch (err) {
    console.error("❌ Parsing/validation failed:", err.message);
    return {
      status: "fallback_to_manual",
      message: "Could not parse a valid accounting output.",
      fallbackUsed: usedFallback,
      rawOutput: null
    };
  }
};
