import { round2 } from "./gstUtil.js";
export function pickTdsRate({ section, policy, panAvailable=true }){
  const rates = policy?.tds?.rates || {}; let r = Number(rates[section]||0);
  if(!panAvailable && policy?.tds?.noPanRateOverride) r = Number(policy.tds.noPanRateOverride);
  return r;
}
export function tdsBaseAmount({ applyOn, taxable, gross }){
  return (applyOn==="amountIncludingGST") ? round2(gross) : round2(taxable);
}
export function computeTDS({ section, policy, taxable, gross, panAvailable }){
  const applyOn = policy?.tds?.applyOn || "amountExcludingGST";
  const base = tdsBaseAmount({ applyOn, taxable, gross });
  const rate = pickTdsRate({ section, policy, panAvailable });
  return { base, rate, tds: round2(base*rate) };
}
