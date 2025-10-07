// services/formats/registry.js
import csvUJ from "./csv-universal-journal-v1.js";
import xlsxUW from "./xlsx-universal-workbook-v1.js";
import csvBS from "./csv-bank-statement-v1.js";
import jsonAP from "./json-audit-package-v1.js";

const PROFILES = [xlsxUW, csvUJ, csvBS, jsonAP];

export function listProfiles() {
  return PROFILES.map(p => ({ id: p.id, displayName: p.displayName, kind: p.kind }));
}
export function getProfile(id) {
  return PROFILES.find(p => p.id === id) || null;
}
export async function autoDetect(peekBuffer, filename = "") {
  const scored = await Promise.all(PROFILES.map(async p => {
    try {
      const s = await p.sniff(peekBuffer, filename);
      return { p, confidence: s?.confidence || 0 };
    } catch { return { p, confidence: 0 }; }
  }));
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored[0] || null;
}
