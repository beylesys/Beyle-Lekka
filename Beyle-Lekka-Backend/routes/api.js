// routes/api.js
import express from "express";
import { orchestratePrompt } from "../controllers/orchestrateController.js";
import { confirmAndSaveEntry } from "../controllers/confirmAndSaveEntry.js";
import * as ledgerCtl from "../controllers/getLedgerView.js"; // works for default or named

const router = express.Router();

// Orchestrate
router.post("/orchestratePrompt", orchestratePrompt);

// Confirm & save
router.post("/confirmAndSaveEntry", confirmAndSaveEntry);

// Ledger — allow BOTH methods (browser tests + UI POST)
const getLedgerView = ledgerCtl.default || ledgerCtl.getLedgerView;
router.get("/getLedgerView", getLedgerView);
router.post("/getLedgerView", getLedgerView);

export default router;
