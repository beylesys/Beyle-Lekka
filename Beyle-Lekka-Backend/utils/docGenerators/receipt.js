// utils/docGenerators/receipt.js
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";
import dotenv from "dotenv";
import { getNextNumber } from "../../services/series.js"; // fallback only
dotenv.config();

const OUTPUT_DIR = path.resolve("./generated_docs");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const CURRENCY = process.env.CURRENCY_SYMBOL || "â‚¹";

function twoDp(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-z0-9\-_.]/gi, "-");
}

/**
 * Accepts a pre-reserved number (from preview snapshot) via:
 *   structured.documentFields.receipt.number   (preferred)
 *   structured.documentFields.receipt.receiptNo (legacy)
 * Falls back to getNextNumber("receipt") ONLY if neither is provided.
 */
export async function generateReceiptDoc({ structured }) {
  const fIn = structured?.documentFields?.receipt;
  if (!fIn) throw new Error("Missing documentFields.receipt");

  // Work on a shallow copy to avoid mutating caller state
  const f = { ...fIn };

  // Minimal validation BEFORE numbering (donâ€™t consume a number if invalid)
  if (f.amount == null || isNaN(Number(f.amount))) {
    throw new Error("Receipt requires a numeric amount.");
  }
  if (!f.receivedFrom) throw new Error("Receipt requires receivedFrom.");
  if (!f.date) throw new Error("Receipt requires date (YYYY-MM-DD).");

  // Normalize amount
  f.amount = twoDp(f.amount);

  // âœ… Prefer reserved number from preview snapshot
  const reserved = f.number || f.receiptNo;
  const receiptNo = reserved || (await getNextNumber("receipt"));
  f.receiptNo = receiptNo; // keep legacy field populated
  f.number = receiptNo;    // keep new field populated for consistency

  const company = f.company || process.env.COMPANY_NAME || "Your Company";

  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "RECEIPT", bold: true, size: 36 })]
  });

  const body = new Paragraph({
    children: [
      new TextRun({ text: `${company}\n`, bold: true }),
      new TextRun({ text: `Receipt No: ${receiptNo}\n` }),
      new TextRun({ text: `Date: ${f.date}\n\n` }),
      new TextRun({
        text: `Received from ${f.receivedFrom} the sum of ${CURRENCY}${f.amount.toFixed(2)} via ${f.mode || "Unspecified"} towards ${f.towards || "dues"}.`
      }),
      ...(f.narration ? [new TextRun({ text: `\nNarration: ${f.narration}` })] : [])
    ]
  });

  const doc = new Document({ sections: [{ children: [title, body] }] });

  // Use receipt number in filename for traceability
  const safeNo = sanitizeForFilename(receiptNo);
  const filename = `receipt-${safeNo}-${uuidv4().slice(0, 8)}.docx`;
  const absPath = path.join(OUTPUT_DIR, filename);

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absPath, buffer);

  return {
    docType: "receipt",
    number: receiptNo,
    filename,
    url: `/files/${filename}`,
    absPath,
    fields: f
  };
}
