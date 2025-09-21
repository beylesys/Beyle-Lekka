// utils/extraction/grnExtractor.js
export function extractGRNFields(text, fileName = "") {
  const out = {};
  const t = text || "";

  const dno = t.match(
    /\b(?:delivery\s*challan|delivery\s*note|dc|grn)\s*(?:no|number|#)\s*[:\-]?\s*([A-Za-z0-9\-\/]+)\b/i
  );
  if (dno) out.delivery_note_number = dno[1].trim();

  const date = t.match(
    /\b(?:date|delivery\s*date)\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}\-\d{2}\-\d{2})/i
  );
  if (date) out.date = normalizeDate(date[1]);

  const sup = t.match(/\b(?:seller|supplier|from|consignor)\s*[:\-]?\s*([A-Za-z0-9&., \-]{3,80})/i);
  if (sup) out.supplier = sup[1].trim();

  if (fileName) out._source_file = fileName;
  return out;
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

export default { extractGRNFields };
