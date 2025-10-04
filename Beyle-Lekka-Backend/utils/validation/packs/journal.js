import schema from "../rules/base/schema.js";
import balance from "../rules/base/balance.js";
import ledgerTypes from "../rules/accounting/ledgerTypes.js";
import periodDate from "../rules/accounting/periodDate.js";
import cashBankFacilities from "../rules/accounting/cashBankFacilities.js"; // funds + OD/OCC/Loan headroom
import idempotency from "../rules/accounting/idempotency.js";

// Note: We intentionally DO NOT include the structural bankCash rule here
// to allow valid bank↔bank transfers in general journals.
export default [
  schema,
  balance,
  ledgerTypes,
  periodDate,
  cashBankFacilities,
  idempotency
];
