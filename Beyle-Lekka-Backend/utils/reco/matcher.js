// utils/reco/matcher.js
// Simple exact-amount-within-window matcher with narration token overlap.

export function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function overlap(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let c = 0;
  for (const t of A) if (B.has(t)) c++;
  return c;
}

/**
 * rankCandidates(bankLine, ledgerCandidates)
 * bankLine: { amount_cents, value_date, narration }
 * ledgerCandidates: array of { id, amount_cents, transaction_date, narration }
 */
export function rankCandidates(bankLine, ledgerCandidates, windowDays = 5) {
  const bDate = new Date(bankLine.value_date);
  return ledgerCandidates
    .filter((l) => {
      const dt = new Date(l.transaction_date);
      const diff = Math.abs((dt - bDate) / (1000*60*60*24));
      return diff <= windowDays && l.amount_cents === Math.abs(bankLine.amount_cents);
    })
    .map((l) => ({
      ...l,
      score: 100 - Math.abs(new Date(l.transaction_date) - bDate) / (1000*60*60*24)
             + overlap(bankLine.narration, l.narration)
    }))
    .sort((a,b) => b.score - a.score);
}
