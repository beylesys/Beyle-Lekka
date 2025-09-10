// utils/docGenerators/invoice.js
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType
} from "docx";
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

export async function generateInvoiceDoc({ structured }) {
  const fIn = structured?.documentFields?.invoice;
  if (!fIn) throw new Error("Missing documentFields.invoice");

  // work on a shallow copy to avoid mutating caller state
  const f = { ...fIn };

  // Minimal validation before numbering (don’t consume a number if invalid)
  if (!Array.isArray(f.items) || f.items.length === 0) {
    throw new Error("Invoice requires at least one item.");
  }
  if (!f.buyer) throw new Error("Invoice requires buyer.");
  if (!f.date) throw new Error("Invoice requires date (YYYY-MM-DD).");

  // Compute line amounts if absent (qty * rate). This is deterministic and not invention.
  f.items = f.items.map((it) => {
    const name = String(it.name || "").trim();
    const qty = Number(it.qty || 0);
    const rate = Number(it.rate || 0);
    const amount = typeof it.amount === "number" ? it.amount : qty * rate;
    return { name, qty, rate, amount: twoDp(amount) };
  });

  // Compute total if not provided; add taxes if present
  const itemsTotal = f.items.reduce((s, it) => s + twoDp(it.amount || 0), 0);
  const taxes = typeof f.taxes === "number" ? twoDp(f.taxes) : 0;
  if (typeof f.totalAmount !== "number") {
    f.totalAmount = twoDp(itemsTotal + taxes);
  } else {
    f.totalAmount = twoDp(f.totalAmount);
  }

  // Get invoice number from series service if not already provided
  const invoiceNo = f.invoiceNo || (await getNextNumber("invoice"));
  f.invoiceNo = invoiceNo;

  const sellerName = f.sellerName || process.env.COMPANY_NAME || "Your Company";
  const sellerAddress = f.sellerAddress || process.env.COMPANY_ADDRESS || "";

  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "TAX INVOICE", bold: true, size: 36 })]
  });

  const header = new Paragraph({
    children: [
      new TextRun({ text: `${sellerName}\n`, bold: true }),
      new TextRun({ text: `${sellerAddress}\n\n` }),
      new TextRun({ text: `Buyer: ${f.buyer}\n` }),
      new TextRun({ text: `Date: ${f.date}\n` }),
      new TextRun({ text: `Invoice No: ${invoiceNo}\n` })
    ]
  });

  const headRow = new TableRow({
    children: ["Item", "Qty", "Rate", "Amount"].map(
      (t) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })]
        })
    )
  });

  const itemRows = f.items.map(
    (it) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(String(it.name || ""))] }),
          new TableCell({ children: [new Paragraph(String(it.qty ?? ""))] }),
          new TableCell({ children: [new Paragraph(String(it.rate ?? ""))] }),
          new TableCell({ children: [new Paragraph(String(twoDp(it.amount ?? 0)))] })
        ]
      })
  );

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headRow, ...itemRows]
  });

  const summary = new Paragraph({
    children: [
      new TextRun(`Taxes: ${taxes ? twoDp(taxes) : "Included/As applicable"}`),
      new TextRun(`\nPayment Mode: ${f.paymentMode ?? "Unspecified"}`),
      new TextRun(`\nTotal: ${CURRENCY}${twoDp(f.totalAmount).toFixed(2)}`)
    ]
  });

  const narration = new Paragraph({
    children: [new TextRun(`Narration: ${f.narration || ""}`)]
  });

  const doc = new Document({
    sections: [{ children: [title, header, table, summary, narration] }]
  });

  // Use invoice number in filename for traceability
  const safeNo = sanitizeForFilename(invoiceNo);
  const filename = `invoice-${safeNo}-${uuidv4().slice(0, 8)}.docx`;
  const absPath = path.join(OUTPUT_DIR, filename);

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absPath, buffer);

  return {
    docType: "invoice",
    number: invoiceNo,
    filename,
    url: `/files/${filename}`,
    absPath,
    fields: f
  };
}
