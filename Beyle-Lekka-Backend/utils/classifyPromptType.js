import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_RESULTS = ["followup", "invoice", "receipt", "voucher", "new", "uncertain"];

// Keep the same meaning as your original prompt, but nudge providers to emit a tiny JSON object.
const SYSTEM_PROMPT = `
You are an AI assistant inside an accounting system. Classify the user's intent into one of:
followup, invoice, receipt, voucher, new, uncertain.

Rules:
- Output must be a JSON object exactly like: {"type":"<one of: followup|invoice|receipt|voucher|new|uncertain>"}.
- No explanations, no extra keys, no punctuation outside JSON.
- Classify by intent (e.g., "received payment ₹5,000" => receipt).
- Use "followup" when the message is likely answering a prior clarification (e.g., only provides a date, amount, or mode).
- Use "uncertain" only if none clearly applies.
`;

// For Claude tool-use fallback (forces one of the enums)
const CLAUDE_TOOL = {
  name: "classify",
  description: "Return a single classification label wrapped in {\"type\":\"...\"}.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { type: "string", enum: VALID_RESULTS }
    }
  }
};

export const classifyPromptType = async (currentPrompt, previousFollowUpChain = []) => {
  try {
    const lastItem = previousFollowUpChain.slice(-1)[0] || "";
    const lastClarification =
      typeof lastItem === "string" ? lastItem : (lastItem?.clarification || "");
    const wordCount = (currentPrompt || "").trim().split(/\s+/).filter(Boolean).length;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: lastClarification
          ? `Earlier clarification: "${lastClarification}"\nUser's current reply: "${currentPrompt}"`
          : `User's prompt: "${currentPrompt}"`
      }
    ];

    console.log("🧠 CLASSIFIER DEBUG");
    console.log("🗂️ Last Clarification:", lastClarification || "[none]");
    console.log("💬 Current Prompt:", currentPrompt);
    console.log("📤 Sending to GPT‑4 (JSON mode)…");

    // --- Primary: OpenAI in JSON mode with a seed (best-effort determinism) ---
    let result = "uncertain";
    try {
      const gptResponse = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        temperature: 0,
        top_p: 1,
        seed: 7,
        response_format: { type: "json_object" },
        messages
      });

      const txt = gptResponse.choices?.[0]?.message?.content?.trim() || "";
      // Prefer JSON parse; if provider still returns plain text, sanitize it.
      try {
        const obj = JSON.parse(txt);
        const t = String(obj?.type || "").trim().toLowerCase();
        if (VALID_RESULTS.includes(t)) result = t;
      } catch {
        const t = txt.replace(/[^a-z]/gi, "").toLowerCase();
        if (VALID_RESULTS.includes(t)) result = t;
      }

      console.log("✅ GPT Classification Result:", result);
    } catch (e) {
      console.error("🚨 OpenAI classify error:", e?.message || e);
    }

    // Short reply override (keep your original behavior)
    if (result === "uncertain" && wordCount <= 10 && lastClarification) {
      console.log("⚠️ 'uncertain' on short reply with prior clarification — overriding to 'followup'");
      return "followup";
    }

    // --- Fallback: Claude with forced tool-use (schema-enforced JSON) ---
    if (result === "uncertain" && process.env.CLAUDE_API_KEY) {
      console.log("🔁 Trying Claude fallback (tool-use)…");
      try {
        const claudeRes = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-3-opus-20240229",
            max_tokens: 120,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: lastClarification
                  ? `Earlier clarification: "${lastClarification}"\nUser's current reply: "${currentPrompt}"`
                  : `User's prompt: "${currentPrompt}"`
              }
            ],
            tools: [CLAUDE_TOOL],
            tool_choice: { type: "tool", name: "classify" }
          },
          {
            headers: {
              "x-api-key": process.env.CLAUDE_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            }
          }
        );

        // Parse Anthropic tool_use block
        const blocks = claudeRes?.data?.content || [];
        const toolUse = blocks.find(b => b?.type === "tool_use" && b?.name === "classify");
        const t = String(toolUse?.input?.type || "").trim().toLowerCase();

        if (VALID_RESULTS.includes(t)) {
          console.log("✅ Claude Classification Result:", t);
          result = t;
        } else {
          // If Claude didn’t use the tool for some reason, try text content
          const text = claudeRes?.data?.content?.[0]?.text?.trim().toLowerCase() || "";
          const cleaned = text.replace(/[^a-z]/gi, "");
          if (VALID_RESULTS.includes(cleaned)) {
            console.log("✅ Claude (text) Classification Result:", cleaned);
            result = cleaned;
          } else {
            console.warn("⚠️ Claude gave unexpected output:", text || toolUse?.input);
          }
        }
      } catch (e) {
        console.error("🚨 Claude classify error:", e?.message || e);
      }

      // Apply the same short reply override after Claude if still uncertain
      if (result === "uncertain" && wordCount <= 10 && lastClarification) {
        console.log("⚠️ (Claude fallback) 'uncertain' on short reply with prior clarification — overriding to 'followup'");
        return "followup";
      }
    }

    return VALID_RESULTS.includes(result) ? result : "uncertain";
  } catch (err) {
    console.error("🚨 classifyPromptType error:", err.message);
    return "uncertain";
  }
};
