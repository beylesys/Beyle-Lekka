// utils/docGenerators/paymentVoucher.js
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";
import dotenv from "dotenv";
import { getNextNumber } from "../../services/series.js"; // ← numbering service
dotenv.config();

const OUTPUT_DIR = path.resolve("./generated_docs");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const CURRENCY = process.env.CURRENCY_SYMBOL || "₹";

function twoDp(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-z0-9\-_.]/gi, "-");
}

export async function generatePaymentVoucherDoc({ structured }) {
  // Accept both keys for compatibility with older calls
  const fIn =
    structured?.documentFields?.payment_voucher ||
    structured?.documentFields?.voucher;

  if (!fIn) throw new Error("Missing documentFields.payment_voucher / voucher");

  // Work on a shallow copy to avoid mutating caller state
  const f = { ...fIn };

  // Minimal validation BEFORE numbering (don’t consume a number if invalid)
  if (f.amount == null || isNaN(Number(f.amount))) {
    throw new Error("Payment voucher requires a numeric amount.");
  }
  if (!f.payee) throw new Error("Payment voucher requires payee.");
  if (!f.date) throw new Error("Payment voucher requires date (YYYY-MM-DD).");

  // Normalize amount
  f.amount = twoDp(f.amount);

  // Get voucher number from series service if not already provided
  // (series key kept as "voucher" to match typical prefixes like PV)
  const voucherNo = f.voucherNo || (await getNextNumber("voucher"));
  f.voucherNo = voucherNo;

  const company = f.company || process.env.COMPANY_NAME || "Your Company";

  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "PAYMENT VOUCHER", bold: true, size: 36 })]
  });

  const body = new Paragraph({
    children: [
      new TextRun({ text: `${company}\n`, bold: true }),
      new TextRun({ text: `Voucher No: ${voucherNo}\n` }),
      new TextRun({ text: `Date: ${f.date}\n\n` }),
      new TextRun({
        text: `Paid ${CURRENCY}${f.amount.toFixed(2)} to ${f.payee} via ${f.mode || "Unspecified"} for ${f.purpose || "Payment"}.`
      }),
      ...(f.narration ? [new TextRun({ text: `\nNarration: ${f.narration}` })] : [])
    ]
  });

  const doc = new Document({ sections: [{ children: [title, body] }] });

  // Use voucher number in filename for traceability
  const safeNo = sanitizeForFilename(voucherNo);
  const filename = `payment-voucher-${safeNo}-${uuidv4().slice(0, 8)}.docx`;
  const absPath = path.join(OUTPUT_DIR, filename);

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absPath, buffer);

  return {
    docType: "payment_voucher", // keep this aligned with inference docType
    number: voucherNo,
    filename,
    url: `/files/${filename}`,
    absPath,
    fields: f
  };
}
