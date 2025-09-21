// utils/extraction/receiptExtractor.js
export function extractReceiptFields(text, fileName = "") {
  const out = {};
  const t = text || "";

  const rno = t.match(/\breceipt\s*(?:no|number|#)\s*[:\-]?\s*([A-Za-z0-9\-\/]+)\b/i);
  if (rno) out.receipt_number = rno[1].trim();

  const date = t.match(
    /\b(?:date|receipt\s*date)\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}\-\d{2}\-\d{2})/i
  );
  if (date) out.date = normalizeDate(date[1]);

  const amt = t.match(/(?:amount\s*received|total|amount)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*\.?\d{0,2})/i);
  if (amt) out.amount = parseAmount(amt[1]);

  const from = t.match(/\b(?:received\s*from|payer|from)\s*[:\-]?\s*([A-Za-z0-9&., \-]{3,80})/i);
  if (from) out.received_from = from[1].trim();

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
      return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    } else {
      const [d, m, y] = parts;
      const yyyy = y.length === 2 ? `20${y}` : y;
      return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return undefined;
}

export default { extractReceiptFields };
