import schema from "../rules/base/schema.js";
import balance from "../rules/base/balance.js";
import ledgerTypes from "../rules/accounting/ledgerTypes.js";
import periodDate from "../rules/accounting/periodDate.js";
import bankCash from "../rules/accounting/bankCash.js";                 // structural hygiene
import cashBankFacilities from "../rules/accounting/cashBankFacilities.js"; // funds + OD/OCC/Loan headroom
import tdsCore from "../rules/tax/tdsCore.js";
import idempotency from "../rules/accounting/idempotency.js";

// Order notes:
// - bankCash (structural) keeps the voucher shape sane.
// - cashBankFacilities enforces funds/headroom BEFORE tax/idempotency.
export default [
  schema,
  balance,
  ledgerTypes,
  periodDate,
  bankCash,
  cashBankFacilities,
  tdsCore,
  idempotency
];
