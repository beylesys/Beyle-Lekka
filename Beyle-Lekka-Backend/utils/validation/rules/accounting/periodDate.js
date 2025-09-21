import { CODES } from "../../codes.js";
import { err, warn } from "../../result.js";
import { isPeriodClosed } from "../../repo.js";
const isISO = s => typeof s==="string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function periodDateRule(ctx){
  const res = { errors:[], warnings:[], info:[] };
  const today = new Date().toISOString().slice(0,10);
  const d = ctx.docModel?.date || ctx.journal?.[0]?.date || today;
  if (!isISO(d)) { res.errors.push(err(CODES.DATE_INVALID,"Date must be YYYY-MM-DD",{date:d})); return res; }

  if (ctx.policy?.allowFutureDates===false && d>today) res.errors.push(err(CODES.DATE_FUTURE,`Future-dated posting not allowed (${d})`,{date:d,today}));
  const back = Number(ctx.policy?.backdateWindowDays||0);
  if (back>0 && d<today) res.warnings.push(warn(CODES.DATE_BACKDATED,`Back-dated by policy window (${back} days)`,{date:d,today,backDays:back}));
  if (await isPeriodClosed(d)) res.errors.push(err(CODES.PERIOD_LOCKED,`Period locked for date ${d}`,{date:d}));

  return res;
}
