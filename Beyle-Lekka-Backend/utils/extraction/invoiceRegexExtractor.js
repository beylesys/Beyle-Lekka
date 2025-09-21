// utils/extraction/invoiceRegexExtractor.js
// Vendor (purchase) invoice fields tolerant to retail slips: Bill/No., Date, Total/Nett, Payment mode.

export function extractInvoiceFields(text, fileName = "", opts = {}) {
  const out = {};
  const t = text || "";

  // Invoice / Bill number (supports "Bill No", "No.", "Invoice No")
  const invNo =
    t.match(/(?:tax\s*invoice\s*no|invoice\s*no|invoice\s*#|inv\s*no|bill\s*no|bill\s*#)\s*[:.\-]?\s*([A-Za-z0-9\-\/]+)\b/i) ||
    t.match(/\bno\s*[.:]\s*([A-Za-z0-9\-\/]+)\b/i); // e.g., "No . 36112"
  if (invNo) out.invoice_number = invNo[1].trim();

  // Invoice date
  const date =
    t.match(/(?:invoice\s*date|bill\s*date|date)\s*[:.\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}\-\d{2}\-\d{2})/i);
  if (date) out.invoice_date = normalizeDate(date[1]);

  // Total / Nett amount (avoid "Total Quantity/Items")
  const total =
    t.match(/(?:nett?\s*amount|amount\s*pay(?:able|ed)|grand\s*total|invoice\s*amount|total\s*amount)\s*[:.\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?\d{0,2})/i) ||
    t.match(/(?:^|\n)\s*total\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?\d{0,2})(?!\s*(?:items|quantity))/i);
  if (total) out.total_amount = parseAmount(total[1]);

  // Payment mode (e.g., "Amount paid through Google Pay")
  const pm = t.match(/amount\s*paid\s*through\s*([A-Za-z ]{3,40})/i);
  if (pm) out.payment_mode = pm[1].trim();

  // GSTIN (often present on retail tax invoices)
  const gst = t.match(/\bgstin\s*[:\-]?\s*([0-9A-Z]{15})/i);
  if (gst) out.gstin = gst[1];

  if (opts && opts.kind === "vendor" && out.vendor) {
    out.counterparty = out.vendor;
    delete out.vendor;
  }
  if (fileName) out._source_file = fileName;
  return out;
}

function parseAmount(s) {
  const clean = String(s).replace(/[, ]+/g, "").trim();
  const n = Number(clean);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeDate(s) {
  const x = s.trim().replace(/\./g, "/").replace(/\-/g, "/");
  const parts = x.split("/");
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      const [y, m, d] = parts;
      return `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    } else {
      const [d, m, y] = parts;
      const yyyy = y.length === 2 ? `20${y}` : y;
      return `${yyyy.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return undefined;
}

export default { extractInvoiceFields };
