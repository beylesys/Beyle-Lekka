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

// NEW: brand‑agnostic Import/Export controllers
import {
  upload as uploadImport,
  startImport,
  getBatch,
  setProfile,
  previewImport,
  commitImport,
  downloadTemplate
} from "../controllers/importsController.js";
import { exportData } from "../controllers/exportsController.js";

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

/* ------------------------------------------------------------------ */
/*                         IMPORT / EXPORT (GENERIC)                   */
/* ------------------------------------------------------------------ */

// Import (brand‑agnostic):
// 1) Upload a file (xlsx/csv/json)
router.post("/import/upload", uploadImport.single("file"), startImport);

// 2) Batch status & suggested profile
router.get("/import/batches/:id", getBatch);

// 3) Override/confirm detected profile
router.post("/import/batches/:id/profile", setProfile);

// 4) Parse & stage (preview)
router.get("/import/batches/:id/preview", previewImport);

// 5) Commit to ledger (atomic + idempotent)
router.post("/import/batches/:id/commit", commitImport);

// 6) Download blank templates per profile
router.get("/import/templates/:profile", downloadTemplate);

// Export (brand‑agnostic):
// GET /api/export?profile=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/export", exportData);

export default router;
