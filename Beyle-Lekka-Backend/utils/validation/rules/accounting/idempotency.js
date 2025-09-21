import { warn } from "../../result.js";
import { CODES } from "../../codes.js";
export default async function idempotencyRule(ctx){
  const out = { errors:[], warnings:[], info:[] };
  if (!ctx.plannedIdempotencyKey) out.warnings.push(warn(CODES.IDEMPOTENCY_MISSING,"Idempotency key not provided in preview payload"));
  return out;
}
