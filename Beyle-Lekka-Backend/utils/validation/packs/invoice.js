import schema from "../rules/base/schema.js";
import balance from "../rules/base/balance.js";
import ledgerTypes from "../rules/accounting/ledgerTypes.js";
import periodDate from "../rules/accounting/periodDate.js";
import bankCash from "../rules/accounting/bankCash.js";                 // structural hygiene (no single-line / no multi-bank)
import cashBankFacilities from "../rules/accounting/cashBankFacilities.js"; // funds + OD/OCC/Loan headroom (runs before totals)
import totals from "../rules/accounting/totals.js";
import gstCore from "../rules/tax/gstCore.js";
import stockGuards from "../rules/inventory/stockGuards.js";
import duplicateInvoice from "../rules/crossDoc/duplicateInvoice.js";
import idempotency from "../rules/accounting/idempotency.js";

// Order matters:
// - schema/balance/ledgerTypes/periodDate -> basic correctness
// - bankCash (structural) -> keeps voucher shape sane for non-accountants
// - cashBankFacilities (funds guard) -> blocks unfundable outflows before totals/gst
// - totals/gst/stock/duplicate/idempotency -> rest of pipeline
export default [
  schema,
  balance,
  ledgerTypes,
  periodDate,
  bankCash,
  cashBankFacilities,
  totals,
  gstCore,
  stockGuards,
  duplicateInvoice,
  idempotency
];
