// utils/extraction/universalExtractor.js
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `
You are a document ingestion engine for an accounting system. You see OCR'ed raw text or extracted text snippets.
Scope: inbound docs (vendor invoices, expense slips, delivery notes, receipts we received, bank slips). If it seems an outbound doc issued by us, classify as own_sales_invoice.
Return ONLY JSON. Never invent.
{
  "status":"success"|"uncertain",
  "doc_semantic_type":"vendor_invoice"|"receipt"|"delivery_note"|"own_sales_invoice"|"bank_slip"|"unknown",
  "direction":"inbound"|"outbound"|"unknown",
  "confidence":0..1,
  "payment":{"status":"paid"|"unpaid"|"partial"|"unknown","mode":string|null},
  "vendor":{"name":string|null,"gstin":string|null},
  "buyer":{"name":string|null,"gstin":string|null},
  "invoice":{"number":string|null,"date":"YYYY-MM-DD"|null},
  "totals":{"subtotal":number|null,"taxes":number|null,"total":number|null}
}
Rules:
- Detect payment clues: phrases like "Amount paid through Google Pay", "Paid by cash", "Paid via UPI/NEFT/Card".
- Normalize dates to YYYY-MM-DD when possible.
- Do not generate items. Only high-level fields.
`;

export async function extractFieldsFromText(rawText, { hint = {} } = {}) {
  if (!rawText || !rawText.trim()) {
    return { ok: false, error: "EMPTY_TEXT", fields: {}, rawText: "" };
  }
  const prompt = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `HINT:\n${JSON.stringify(hint, null, 2)}\n\nRAW_TEXT:\n"""${rawText.slice(0, 18000)}"""` }
  ];
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: prompt
    });
    const out = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    if (out?.status !== "success") {
      return { ok: false, error: "LLM_UNCERTAIN", fields: {}, rawText };
    }
    const docType = String(out.doc_semantic_type || "unknown").toLowerCase();
    const fields = {
      vendor_name: out.vendor?.name || null,
      gstin: out.vendor?.gstin || null,
      buyer_name: out.buyer?.name || null,
      buyer_gstin: out.buyer?.gstin || null,
      invoice_number: out.invoice?.number || null,
      invoice_date: out.invoice?.date || null,
      subtotal_amount: out.totals?.subtotal ?? null,
      tax_amount: out.totals?.taxes ?? null,
      total_amount: out.totals?.total ?? null,
      payment_mode: out.payment?.mode || null,
      paid: out.payment?.status === "paid" || out.payment?.status === "partial" || false,
    };
    return {
      ok: true,
      docType: (
        docType.includes("receipt") ? "receipt" :
        docType.includes("delivery") ? "delivery_note" :
        docType.includes("own_sales") ? "own_sales_invoice" :
        docType.includes("vendor") ? "vendor_invoice" :
        docType.includes("bank") ? "bank_slip" : "unknown"
      ),
      fields,
      meta: { direction: out.direction || "unknown", confidence: out.confidence ?? 0 },
      rawText
    };
  } catch (e) {
    return { ok: false, error: e.message || "LLM extraction failed", fields: {}, rawText };
  }
}
