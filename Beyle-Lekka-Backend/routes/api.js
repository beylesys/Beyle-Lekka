// routes/api.js
import express from "express";
import { orchestratePrompt } from "../controllers/orchestrateController.js";
import { confirmAndSaveEntry } from "../controllers/confirmAndSaveEntry.js";
import { getLedgerView } from "../controllers/getLedgerView.js";
import { updateLedgerEntry } from "../controllers/updateLedgerEntry.js";
import {
  trialBalance,
  profitAndLoss,
  balanceSheet
} from "../controllers/reportsController.js";
import {
  upload as uploadDocs,
  uploadAndExtract
} from "../controllers/documentsController.js";
import {
  uploadCSV as uploadBankCSV,
  importBankCSV,
  suggestions,
  confirmMatch
} from "../controllers/bankReconciliation.js";
import { tenantStub } from "../middleware/tenant.js"; // <-- correct relative path

const router = express.Router();

// Mount tenant middleware for all /api routes
router.use(tenantStub());

// Orchestrate (preview)
router.post("/orchestratePrompt", orchestratePrompt);

// Confirm & save
router.post("/confirmAndSaveEntry", confirmAndSaveEntry);

// Ledger view
router.get("/getLedgerView", getLedgerView);
router.post("/getLedgerView", getLedgerView);

// Update ledger line
router.post("/ledger/update", updateLedgerEntry);

// Reports
router.get("/reports/trial-balance", trialBalance);
router.get("/reports/pl",            profitAndLoss);
router.get("/reports/bs",            balanceSheet);

// Document upload & extraction
router.post("/documents/upload", uploadDocs.single("file"), uploadAndExtract);

// Bank reconciliation
router.post("/bankreco/import",      uploadBankCSV.single("file"), importBankCSV);
router.get ("/bankreco/suggestions", suggestions);
router.post("/bankreco/match",       confirmMatch);

export default router;
