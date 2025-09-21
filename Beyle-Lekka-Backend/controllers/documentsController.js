// controllers/documentsController.js
// Inbound-only: robust upload + extract + classify (no raw text leakage)
// Text: pdf-parse → embedded JPEG → Tesseract OCR (Windows friendly).
// Fields: universal LLM extractor (no brittle regex).
// Items: Tabula (deterministic) → scales to thousands of rows.
// Guardrails: totals vs sum(items).
// Degrades gracefully if Tabula/Java missing.

import multer from "multer";
import path from "path";
import fs from "fs";
import { Buffer } from "buffer";
import { randomUUID } from "crypto";

import { extractTablesWithTabula } from "../services/tabula.js";
import { extractItemsFromTables } from "../utils/extraction/lineItemsExtractor.js";
import { extractFieldsFromText } from "../utils/extraction/universalExtractor.js";

// NEW: classifier is now used at extraction-time
import { classifyPromptType } from "../utils/classifyPromptType.js";

// ---------- Multer upload middleware ----------
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB for very large PDFs
});

// ---------- Org identity (optional) ----------
const ORG_NAME = (process.env.ORG_NAME || "").toLowerCase().trim();
const ORG_GSTIN = (process.env.ORG_GSTIN || "").toLowerCase().trim();
const ORG_PAN = (process.env.ORG_PAN || "").toLowerCase().trim();

function isOwnBusinessDoc(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const nameHit = ORG_NAME && t.includes(ORG_NAME);
  const gstHit = ORG_GSTIN && t.includes(ORG_GSTIN);
  const panHit = ORG_PAN && t.includes(ORG_PAN);
  const issuerHints = /\b(seller|supplier|from|issuer|billed\s*by|tax\s*invoice)\b/.test(t);
  return (nameHit || gstHit || panHit) && issuerHints;
}

// ---------- Minimal legacy detectors (fallback only) ----------
function detectInboundDocTypeFromText(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.toLowerCase();
  if (/\breceipt\b/.test(t) || /\bpayment\s+received\b/.test(t) || /\breceived with thanks\b/.test(t)) return "receipt";
  if (/\b(delivery\s*challan|delivery\s*note|dc\s*no|goods\s*receipt|grn)\b/.test(t)) return "delivery_note";
  if (/\btax\s*invoice\b/.test(t) || (/\binvoice\b/.test(t) && (/\bgstin\b/.test(t) || /\bhsn\b/.test(t)))) return "vendor_invoice";
  return null;
}

// ---------- OCR helpers ----------
async function ocrBuffer(buf) {
  try {
    const Tesseract = (await import("tesseract.js")).default;
    const res = await Tesseract.recognize(buf, "eng");
    return (res?.data?.text || "").trim();
  } catch (e) {
    console.warn("OCR unavailable:", e?.message);
    return "";
  }
}

// Extract first embedded JPEG (DCTDecode) from a PDF buffer (common for scanned receipts)
function extractFirstJpegFromPdfBuffer(pdfBuffer) {
  try {
    const dct = Buffer.from("/DCTDecode");
    let seek = 0;
    for (;;) {
      const dctPos = pdfBuffer.indexOf(dct, seek);
      if (dctPos === -1) break;

      const streamToken = Buffer.from("stream");
      const endStreamToken = Buffer.from("endstream");
      const streamPos = pdfBuffer.indexOf(streamToken, dctPos);
      if (streamPos === -1) break;

      let start = streamPos + streamToken.length;
      if (pdfBuffer[start] === 0x0d && pdfBuffer[start + 1] === 0x0a) start += 2;
      else if (pdfBuffer[start] === 0x0a) start += 1;

      const endPos = pdfBuffer.indexOf(endStreamToken, start);
      if (endPos === -1) break;

      const raw = pdfBuffer.slice(start, endPos);
      const soi = raw.indexOf(Buffer.from([0xff, 0xd8]));
      const eoi = raw.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (soi !== -1 && eoi !== -1 && eoi > soi) return raw.slice(soi, eoi + 2);
      if (raw.length > 1024) return raw;

      seek = endPos + endStreamToken.length;
    }
  } catch {}
  return null;
}

async function extractTextFromUpload(file, fallbackText = "") {
  if (fallbackText && typeof fallbackText === "string") return fallbackText;
  if (!file || !file.buffer) return "";

  const original = file.originalname || "";
  const ext = path.extname(original).toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  // 1) PDFs: try text layer
  if (ext === ".pdf" || mime.includes("pdf")) {
    let text = "";
    try {
      const pdfParseMod = await import("pdf-parse");
      const pdfParse = pdfParseMod.default || pdfParseMod;
      const res = await pdfParse(file.buffer);
      text = (res && res.text) ? String(res.text).trim() : "";
    } catch (e) {
      console.warn("pdf-parse failed:", e?.message);
    }
    if (text && text.length >= 40) return text;

    // 2) Fallback: OCR embedded JPEG
    const jpeg = extractFirstJpegFromPdfBuffer(file.buffer);
    if (jpeg) {
      const ocr = await ocrBuffer(jpeg);
      if (ocr.length >= 20) return ocr;
    }
    return text || "";
  }

  // 2) plain text
  if (ext === ".txt" || mime.includes("text")) {
    try { return Buffer.from(file.buffer).toString("utf8"); } catch { return ""; }
  }

  // 3) images → OCR
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|tiff?)$/.test(ext)) {
    return await ocrBuffer(file.buffer);
  }

  return "";
}

// Save a temp PDF if we need Tabula (deterministic table extraction)
function saveTempPdf(buffer) {
  const dir = path.resolve("uploads", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  const name = `ux-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, buffer);
  return {
    path: fp,
    cleanup: () => fs.promises.unlink(fp).catch(() => {})
  };
}

// Small helper to keep classification payload tidy
function sanitizeClassification(cls) {
  if (!cls || typeof cls !== "object") return null;
  const allow = [
    "type",
    "docSemanticType", "semanticType",
    "promptType", "flow",
    "confidence", "reason",
    "signals",
    "missingRequired", "requiredForType"
  ];
  const out = {};
  for (const k of allow) if (k in cls) out[k] = cls[k];
  return out;
}

// ---------- Text-only parse (for test tools) ----------
export async function parseDocument(req, res) {
  try {
    const { text = "", fileName = "" } = req.body || {};
    const content = String(text || "");

    // Universal fields (LLM)
    const fieldsRes = await extractFieldsFromText(content, {
      hint: { our_name: process.env.ORG_NAME || null, our_gstin: process.env.ORG_GSTIN || null }
    });

    if (!fieldsRes.ok) {
      const guess = detectInboundDocTypeFromText(content);
      return res.json({
        ok: false,
        docType: guess || "unknown",
        fields: {},
        rawTextLength: content.length,
        reason: "LLM uncertain for the provided text."
      });
    }

    // If it's an outbound doc we raised, ignore (inbound-only screen)
    if (String(fieldsRes.docType) === "own_sales_invoice") {
      return res.json({
        ok: true,
        docType: "own_sales_invoice",
        fields: fieldsRes.fields || {},
        rawTextLength: content.length,
        reason: "Appears to be issued by your own business; inbound docs only.",
        meta: fieldsRes.meta
      });
    }

    // Optionally classify here as well for parity
    let docType = fieldsRes.docType || "unknown";
    let classification = null;
    try {
      classification = await classifyPromptType({
        currentPrompt: "",
        previousFollowUpChain: [],
        parsedDocType: docType,
        parsedFields: fieldsRes.fields || {}
      });
      const sem = classification?.docSemanticType || classification?.semanticType || classification?.type;
      if (sem && typeof sem === "string") docType = sem;
    } catch (e) {
      // keep heuristic docType; classification optional in this endpoint
    }

    return res.json({
      ok: true,
      docType,
      classification: sanitizeClassification(classification),
      fields: fieldsRes.fields || {},
      rawTextLength: content.length,
      meta: fieldsRes.meta
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || "Failed to parse document" });
  }
}

// ---------- Upload & Extract ----------
export const uploadAndExtract = async (req, res) => {
  try {
    const file = req.file || null;
    const incomingText = req.body?.text || "";
    const fileName = file?.originalname || req.body?.fileName || "";
    const extractionId = randomUUID();

    // developer-controlled debug gate (rawText only if debug=1)
    const debug = String(req.query?.debug || req.body?.debug || "0") === "1";

    // 1) Get raw text (pdf-parse → OCR fallback)
    const rawText = await extractTextFromUpload(file, incomingText);
    const rawTextLength = (rawText || "").length;

    // 2) Universal field extraction (LLM)
    let fieldsRes = await extractFieldsFromText(rawText, {
      hint: { our_name: process.env.ORG_NAME || null, our_gstin: process.env.ORG_GSTIN || null }
    });

    // Extra inbound-only guard if env hints are missing
    if (!fieldsRes.ok && isOwnBusinessDoc(rawText)) {
      return res.json({
        ok: true,
        fileId: extractionId,
        extractionId,
        docType: "own_sales_invoice",
        fields: {},
        ...(debug ? { rawText } : {}), // ← rawText only in debug mode
        meta: { direction: "outbound" },
        reason: "Appears issued by your own business; inbound docs only."
      });
    }

    // Fallback type guess if LLM is uncertain
    let docType = fieldsRes.ok ? fieldsRes.docType : (detectInboundDocTypeFromText(rawText) || "unknown");

    // 3) Items via Tabula (deterministic) when PDF buffers available — SAFE VERSION
    let items = [];
    let itemsMeta = { picked: null, confidence: 0, reason: null };
    const isPdf =
      (file?.mimetype || "").toLowerCase().includes("pdf") ||
      (fileName || "").toLowerCase().endsWith(".pdf");

    if (isPdf && file?.buffer?.length > 0) {
      const tmp = saveTempPdf(file.buffer);
      try {
        const tab = await extractTablesWithTabula(tmp.path, "all");

        if (tab.ok && Array.isArray(tab.tables) && tab.tables.length > 0) {
          try {
            const take = extractItemsFromTables(tab.tables);
            items = Array.isArray(take.items)
              ? take.items.filter(it => it && (it.name || it.amount != null || it.qty != null || it.rate != null))
              : [];
            itemsMeta = {
              picked: take.picked ?? null,
              confidence: Number(take.confidence) || 0,
              reason: take.reason || null
            };
          } catch (e) {
            items = [];
            itemsMeta = { picked: null, confidence: 0, reason: `extractItems error: ${e.message}` };
          }
        } else {
          items = [];
          itemsMeta = { picked: null, confidence: 0, reason: tab.error || "tabula_no_tables" };
        }
      } catch (e) {
        items = [];
        itemsMeta = { picked: null, confidence: 0, reason: `tabula_invoke_error: ${e.message}` };
      } finally {
        tmp.cleanup();
      }
    } else {
      itemsMeta = { picked: null, confidence: 0, reason: "non_pdf_or_empty_buffer" };
    }

    // 4) Guardrails: compare items total vs header total
    const fields = fieldsRes.ok ? (fieldsRes.fields || {}) : {};
    const totalFromItems = items.reduce((s, it) => s + (Number(it.amount || 0)), 0);
    const totalFromFields = Number(fields.total_amount || 0) || null;
    const within1pct =
      totalFromFields != null && totalFromFields > 0
        ? Math.abs(totalFromItems - totalFromFields) <= Math.max(1, totalFromFields * 0.01)
        : true;

    const guardWarnings = [];
    if (items.length && totalFromFields != null && !within1pct) {
      guardWarnings.push({
        code: "TOTALS_MISMATCH",
        msg: `Sum(items)=${totalFromItems.toFixed(2)} vs total=${totalFromFields.toFixed(2)}`
      });
    }

    // 5) Outbound (raised by us) → not handled in this Inbound Upload screen
    if (docType === "own_sales_invoice") {
      return res.status(200).json({
        ok: true,
        fileId: extractionId,
        extractionId,
        docType,
        fields,
        ...(debug ? { rawText } : {}), // ← rawText only in debug mode
        meta: {
          ...(fieldsRes.meta || {}),
          items_confidence: itemsMeta.confidence,
          picked: itemsMeta.picked,
          guardWarnings
        },
        reason: "Appears to be issued by your own business; inbound docs only."
      });
    }

    // Merge items only when confident OR when totals are absent
    const includeItems = items.length > 0 && (within1pct || totalFromFields == null);
    const mergedFields = includeItems ? { ...fields, items } : fields;

    // 6) Classification at extraction-time (source of truth for UI/orchestrator)
    let classification = null;
    try {
      classification = await classifyPromptType({
        currentPrompt: "",
        previousFollowUpChain: [],
        parsedDocType: docType || "unknown",
        parsedFields: mergedFields
      });
      const sem = classification?.docSemanticType || classification?.semanticType || classification?.type;
      if (sem && typeof sem === "string") docType = sem;
    } catch (e) {
      console.warn("classifyPromptType (upload) failed:", e?.message || e);
    }

    // 7) Final payload for UI/orchestrator (NO rawText unless debug=1)
    return res.status(200).json({
      ok: true,
      fileId: extractionId,
      extractionId,
      docType: docType || "unknown",
      classification: sanitizeClassification(classification),
      fields: mergedFields,
      ...(debug ? { rawText } : {}), // ← rawText only in debug mode
      meta: {
        ...(fieldsRes.meta || {}),
        items_confidence: itemsMeta.confidence,
        picked: itemsMeta.picked,
        guardWarnings
      },
      snippet: (rawText || "").slice(0, 180),
      rawTextLength
    });
  } catch (err) {
    console.error("uploadAndExtract error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Failed to upload & extract document" });
  }
};

export default { upload, uploadAndExtract, parseDocument };
