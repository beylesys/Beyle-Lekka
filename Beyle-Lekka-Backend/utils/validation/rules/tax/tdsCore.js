import { err } from "../../result.js";
import { computeTDS } from "../../../tax/tdsUtil.js";
import { round2 } from "../../../tax/gstUtil.js";
import { CODES } from "../../codes.js";
import { getTdsFyAggregate } from "../../../../services/tdsAggregates.js";


/** ---------- helpers ---------- */
const EPS = 0.05;
const clean = (s) => String(s || "").trim().toLowerCase();
const isNum = (x) => Number.isFinite(Number(x));

/** Build a case-insensitive matcher that also matches "TDS Payable - 194J" etc. */
function makeLedgerMatcher(reqName = "TDS Payable") {
  const esc = reqName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // start with name, then end OR space OR hyphen
  const rx = new RegExp(`^${esc}(\\b|\\s|[-–—])?`, "i");
  return (accountName) => rx.test(String(accountName || ""));
}

/** Map expense ledger names to likely TDS section. */
function detectSectionFromExpenseLines(journal = []) {
  const debitLines = (journal || []).filter((l) => Number(l?.debit || 0) > 0);

  let best = null; // { section, amount }
  for (const l of debitLines) {
    const name = clean(l.account);
    if (!name) continue;
    // ignore tax/round-off/instrument
    if (/gst\s*input|igst|cgst|sgst|round[-\s]*off|tds\s*(receivable|payable)|bank|cash/.test(name)) continue;

    let section = null;
    if (/professional|consult|legal|audit|architect|engineer|technical|management/.test(name)) section = "194J";
    else if (/commission|brokerage/.test(name)) section = "194H";
    else if (/rent|lease/.test(name)) section = "194I";
    else if (/contract|job\s*work|contractor|labou?r|advertis(ing|ement)/.test(name)) section = "194C";

    if (!section) continue;
    const amt = Number(l.debit || 0);
    if (!best || amt > best.amount) best = { section, amount: amt };
  }
  return best; // null or {section, amount}
}

/** Try to identify a payee string (for FY aggregation). */
function getPayee(ctx) {
  const dm = ctx.docModel || {};
  const pv = dm.payment_voucher || dm.voucher || {};
  if (pv.payee) return String(pv.payee).trim();

  // fallback: creditor line name if present
  const cred = (ctx.journal || []).find(
    (l) =>
      /creditors?|accounts\s*payable|supplier|vendor/i.test(String(l?.account || "")) &&
      Number(l?.credit || 0) > 0
  );
  if (cred) return String(cred.account).replace(/^(creditors?|accounts\s*payable)\s*-\s*/i, "").trim();
  return null;
}

function singlePaymentAbove(policy, section, amount) {
  const m = policy?.tds?.autoDetect?.singlePaymentThresholds || {};
  const th = m[section];
  if (!isNum(th)) return false; // if undefined → single-payment test not used
  return Number(amount || 0) >= Number(th);
}
function annualThreshold(policy, section) {
  const m = policy?.tds?.autoDetect?.annualAggregateThresholds || {};
  const th = m[section];
  return isNum(th) ? Number(th) : Infinity;
}

/** Approximate taxable and gross from the journal when docModel doesn't carry them. */
function deriveAmounts(ctx) {
  const j = Array.isArray(ctx?.journal) ? ctx.journal : [];
  const sum = (arr, f) => arr.reduce((s, l) => s + (Number(f(l)) || 0), 0);
  const totalCredits = sum(j, (l) => l.credit);
  const totalDebits = sum(j, (l) => l.debit);
  const gstDebits = sum(j, (l) =>
    /gst\s*input|igst|cgst|sgst/i.test(String(l.account || "")) ? Number(l.debit || 0) : 0
  );
  const taxableApprox = round2(totalDebits - gstDebits);
  return { taxableApprox, grossApprox: round2(totalCredits || totalDebits) };
}

/** Read TDS amount from journal if the ledger exists (credit - debit, abs). */
function tdsAmountFromJournal(ctx, reqName = "TDS Payable") {
  const match = makeLedgerMatcher(reqName);
  let net = 0;
  for (const l of ctx.journal || []) {
    if (match(l.account)) {
      const cr = Number(l?.credit || 0);
      const dr = Number(l?.debit || 0);
      net += cr - dr;
    }
  }
  return Math.abs(round2(net));
}

export default async function tdsCoreRule(ctx) {
  const res = { errors: [], warnings: [], info: [] };
  if (!ctx.policy?.tds?.enabled) return res;

  const dm = ctx.docModel || {};
  const isPV = ctx.docType === "payment_voucher";

  // 1) Explicit apply wins
  let applies = dm.tds?.apply === true;
  let section = dm.tds?.section || null;

  // 2) Auto-detect only for payment vouchers
  if (!applies && isPV) {
    const guess = detectSectionFromExpenseLines(ctx.journal);
    if (guess) {
      section = section || guess.section;

      // Single-payment gate
      const singleHit = singlePaymentAbove(ctx.policy, guess.section, guess.amount);

      // Annual-aggregate gate
      let annualHit = false;
      const annualTh = annualThreshold(ctx.policy, guess.section);
      if (Number.isFinite(annualTh)) {
        const payee = getPayee(ctx);
        if (payee) {
          const dateISO = dm?.date || (ctx.journal?.[0]?.date) || null;
          try {
            const soFar = await getTdsFyAggregate({
              sessionId: ctx.sessionId,
              payee,
              section: guess.section,
              asOfDateISO: dateISO,
              fyStartMonth: ctx.policy?.financialYear?.startMonth || 4,
              fyStartDay: ctx.policy?.financialYear?.startDay || 1,
            });
            annualHit = Number(soFar || 0) + Number(guess.amount || 0) >= Number(annualTh);
          } catch {
            // If aggregate lookup fails, do not block; rely on single-payment only
            annualHit = false;
          }
        }
      }

      applies = singleHit || annualHit;
    }
  }

  if (!applies) return res; // Not applicable → no TDS flags

  if (!section) {
    res.errors.push(err(CODES.TDS_SECTION_MISSING, "TDS section is required when TDS applies"));
    return res;
  }

  // Amounts: prefer docModel, else derive from journal
  const { taxableApprox, grossApprox } = deriveAmounts(ctx);
  const taxable = Number(dm.taxable || dm.subtotal || taxableApprox || 0);
  const gross = Number(dm.total || grossApprox || 0);

  const panAvailable = dm.tds?.panAvailable !== false;

  const { base, rate, tds: expected } = computeTDS({
    section,
    policy: ctx.policy,
    taxable,
    gross,
    panAvailable,
  });

  // Prefer explicit docModel.tds.amount; else read from journal ledger
  const reqName = ctx.policy?.tds?.requireLedger || "TDS Payable";
  const shownFromLedger = tdsAmountFromJournal(ctx, reqName);
  const shownDocModel = Number(dm.tds?.amount || 0);
  const shown = shownDocModel > 0 ? round2(shownDocModel) : round2(shownFromLedger);

  if (Math.abs(shown - expected) > EPS) {
    res.errors.push(
      err(CODES.TDS_MISMATCH, `Expected TDS ${expected} vs shown ${shown}`, {
        section,
        base,
        rate,
        expected,
        shown,
        source: shownDocModel > 0 ? "docModel" : "journal",
      })
    );
  }

  // Require the ledger to exist
  const hasReqLedger = (ctx.journal || []).some((l) => makeLedgerMatcher(reqName)(l.account));
  if (!hasReqLedger) {
    res.errors.push(err(CODES.TDS_LEDGER_MISSING, `Required TDS ledger not found in entry: ${reqName}`));
  }

  return res;
}
