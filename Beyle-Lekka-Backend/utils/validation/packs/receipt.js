import schema from "../rules/base/schema.js";
import balance from "../rules/base/balance.js";
import ledgerTypes from "../rules/accounting/ledgerTypes.js";
import periodDate from "../rules/accounting/periodDate.js";
import bankCash from "../rules/accounting/bankCash.js";                 // structural hygiene
import cashBankFacilities from "../rules/accounting/cashBankFacilities.js"; // funds + OD/OCC/Loan headroom
import idempotency from "../rules/accounting/idempotency.js";

export default [
  schema,
  balance,
  ledgerTypes,
  periodDate,
  bankCash,
  cashBankFacilities,
  idempotency
];
