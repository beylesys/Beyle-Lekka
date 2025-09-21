// utils/extraction/lineItemsExtractor.js
// Heuristic items extractor over Tabula rows (string[][]).

const HEADER_SYNONYMS = {
  description: [/^desc(ription)?$/i, /^item$/i, /^product$/i, /^part/i, /^goods/i, /^material/i, /^hsn.*desc/i],
  hsn: [/^hsn/i, /^sac/i],
  qty: [/^qty$/i, /^quantity$/i, /^qnty/i, /^nos?$/i, /^pcs?$/i, /^units?$/i, /^kg$/i, /^lit(re|er)$/i],
  rate: [/^rate$/i, /^price$/i, /^mrp$/i, /^unit\s*price$/i],
  amount: [/^amount$/i, /^value$/i, /^total$/i, /^line\s*total$/i]
};

function normalizeHeader(h) {
  const x = (h || "").toString().trim().replace(/\s+/g, " ");
  for (const [canon, pats] of Object.entries(HEADER_SYNONYMS)) {
    if (pats.some(re => re.test(x))) return canon;
  }
  return x.toLowerCase();
}

function toNum(x) {
  if (x === null || x === undefined) return null;
  const cleaned = String(x).replace(/[^\d.\-]/g, "");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Given Tabula tables: [{ page, rows: string[][] }]
 * Returns { items:[], confidence:0..1, picked:{page,index}|null, reason? }
 */
export function extractItemsFromTables(tables = []) {
  if (!Array.isArray(tables)) return { items: [], confidence: 0, picked: null, reason: "no_tables" };

  const candidates = [];

  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    let rows = Array.isArray(t?.rows) ? t.rows.filter(Array.isArray) : [];
    // strip blank rows
    rows = rows.filter(r => Array.isArray(r) && r.some(c => (c || "").trim().length > 0));
    if (rows.length < 2) continue;

    // header: first non-empty row
    const headerRow = rows[0].map(c => c.toString());
    const header = headerRow.map(normalizeHeader);

    const idx = {
      description: header.findIndex(h => h === "description"),
      qty: header.findIndex(h => h === "qty"),
      rate: header.findIndex(h => h === "rate"),
      amount: header.findIndex(h => h === "amount")
    };

    const hasMin = idx.description >= 0 && (idx.qty >= 0 || idx.rate >= 0 || idx.amount >= 0);
    if (!hasMin) continue;

    const bodyRows = rows.slice(1);
    let good = 0, amountPresent = 0;
    for (const r of bodyRows) {
      if (!Array.isArray(r)) continue;
      const name = (r[idx.description] || "").trim();
      const qty = idx.qty >= 0 ? toNum(r[idx.qty]) : null;
      const rate = idx.rate >= 0 ? toNum(r[idx.rate]) : null;
      const amt = idx.amount >= 0 ? toNum(r[idx.amount]) : null;
      if (name.length > 1 && (qty !== null || rate !== null || amt !== null)) {
        good++;
        if (amt !== null) amountPresent++;
      }
    }
    if (good >= 2) {
      const conf = Math.min(1, 0.4 + 0.2 * (idx.qty >= 0) + 0.2 * (idx.rate >= 0) + 0.2 * (idx.amount >= 0)) *
                   Math.min(1, good / 10);
      candidates.push({ i, page: t.page || null, header, idx, good, conf, rows: bodyRows });
    }
  }

  if (!candidates.length) return { items: [], confidence: 0, picked: null, reason: "no_table_candidate" };

  candidates.sort((a, b) => b.conf - a.conf);
  const best = candidates[0];

  const items = [];
  for (const r of best.rows) {
    if (!Array.isArray(r)) continue;
    const name = (r[best.idx.description] || "").trim();
    if (!name) continue;
    const qty = best.idx.qty >= 0 ? toNum(r[best.idx.qty]) : null;
    const rate = best.idx.rate >= 0 ? toNum(r[best.idx.rate]) : null;
    let amount = best.idx.amount >= 0 ? toNum(r[best.idx.amount]) : null;
    if (amount === null && qty !== null && rate !== null) amount = +(qty * rate).toFixed(2);
    items.push({ name, qty, rate, amount });
  }

  return { items, confidence: best.conf, picked: { page: best.page, index: best.i } };
}
