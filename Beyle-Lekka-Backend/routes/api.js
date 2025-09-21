// routes/api.js (full replacement)
import express from "express";
import { orchestratePrompt } from "../controllers/orchestrateController.js";
import { confirmAndSaveEntry } from "../controllers/confirmAndSaveEntry.js";
import * as ledgerCtl from "../controllers/getLedgerView.js";
import { updateLedgerEntry } from "../controllers/updateLedgerEntry.js";
import { trialBalance, profitAndLoss, balanceSheet } from "../controllers/reportsController.js";
import { upload as uploadDocs, uploadAndExtract } from "../controllers/documentsController.js";
import { uploadCSV as uploadBankCSV, importBankCSV, suggestions, confirmMatch } from "../controllers/bankReconciliation.js";

const router = express.Router();

// Orchestrate (preview)
router.post("/orchestratePrompt", orchestratePrompt);

// Confirm & save (legacy)
router.post("/confirmAndSaveEntry", confirmAndSaveEntry);

// Ledger view
const getLedgerView = ledgerCtl.default || ledgerCtl.getLedgerView;
router.get("/getLedgerView", getLedgerView);
router.post("/getLedgerView", getLedgerView);

router.post("/ledger/update", updateLedgerEntry);

// Reports
router.get("/reports/trial-balance", trialBalance);
router.get("/reports/pl", profitAndLoss);
router.get("/reports/bs", balanceSheet);

// Document upload & extraction
router.post("/documents/upload", uploadDocs.single("file"), uploadAndExtract);

// Bank reconciliation
router.post("/bankreco/import", uploadBankCSV.single("file"), importBankCSV);
router.get("/bankreco/suggestions", suggestions);
router.post("/bankreco/match", confirmMatch);

export default router;
