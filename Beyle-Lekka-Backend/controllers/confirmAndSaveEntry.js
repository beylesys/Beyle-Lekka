// controllers/confirmAndSaveEntry.js
import { saveJournalEntry } from "../utils/saveJournalEntry.js";
import { validateAndPreparePreview, pairForLedger } from "../utils/jeCore.js";
import { ensureLedgerExists } from "../utils/coaService.js";

import { generateInvoiceDoc } from "../utils/docGenerators/invoice.js";
import { generateReceiptDoc } from "../utils/docGenerators/receipt.js";
import { generatePaymentVoucherDoc } from "../utils/docGenerators/paymentVoucher.js";

import { clearOrchestratorSession } from "./orchestrateController.js";

function pickDocFields(docType, documentFields = {}) {
  if (!docType || docType === "none") return null;
  if (documentFields[docType]) return documentFields[docType];
  if (docType === "payment_voucher") {
    return documentFields.payment_voucher || documentFields.voucher || null;
  }
  return null;
}

function appendDocRefToNarration(rows, docType, docNumber) {
  if (!docNumber || !Array.isArray(rows)) return rows;
  const label =
    docType === "invoice" ? "Invoice No" :
    docType === "receipt" ? "Receipt No" :
    docType === "payment_voucher" ? "Voucher No" :
    "Doc No";
  const suffix = ` [${label}: ${docNumber}]`;
  return rows.map((r) => ({
    ...r,
    narration: (r.narration ? String(r.narration) : "").trim() + suffix
  }));
}

export const confirmAndSaveEntry = async (req, res) => {
  try {
    const {
      sessionId = "default-session",
      journal,
      prompt,
      confirmed,
      docType = "none",
      documentFields = {}
    } = req.body || {};

    console.log("📩 Incoming confirmation payload:", {
      sessionId,
      confirmed,
      journalLines: Array.isArray(journal) ? journal.length : 0,
      docType,
      hasDocFields: !!documentFields && Object.keys(documentFields).length > 0
    });

    if (!Array.isArray(journal) || journal.length === 0) {
      return res.status(400).json({ error: "Journal is required." });
    }

    // Validate (same as preview; ensures no drift)
    const check = await validateAndPreparePreview(journal, { allowFutureDates: false });
    if (!check.ok) {
      return res
        .status(422)
        .json({ success: false, status: "invalid", errors: check.errors, warnings: check.warnings });
    }

    // Generate document first so we can stamp number into narration
    let document = null;
    if (docType && docType !== "none") {
      const df = pickDocFields(docType, documentFields);
      if (!df) {
        return res.status(422).json({
          success: false,
          status: "invalid",
          error: `Missing documentFields for docType: ${docType}`
        });
      }
      const structured =
        docType === "invoice"
          ? { documentFields: { invoice: df } }
          : docType === "receipt"
          ? { documentFields: { receipt: df } }
          : { documentFields: { payment_voucher: df } };

      try {
        if (docType === "invoice") document = await generateInvoiceDoc({ structured });
        else if (docType === "receipt") document = await generateReceiptDoc({ structured });
        else if (docType === "payment_voucher") document = await generatePaymentVoucherDoc({ structured });
      } catch (e) {
        console.error("🟥 Document generation failed:", e);
        return res.status(422).json({
          success: false,
          status: "invalid",
          error: `Document generation failed: ${e?.message || "Unknown error"}`
        });
      }
    }

    // Ensure ledgers exist
    for (const acc of check.newAccounts) {
      const usedOnDebit = check.normalized.some((l) => l.account === acc && l.debit > 0);
      await ensureLedgerExists(acc, { debit: usedOnDebit });
    }

    // Stamp doc number into narrations (if any)
    const normalizedForSave =
      document && document.number
        ? appendDocRefToNarration(check.normalized, docType, document.number)
        : check.normalized;

    // Pair & save
    const rows = pairForLedger(normalizedForSave);
    if (!rows.length) {
      return res.status(400).json({ success: false, error: "No valid ledger rows were produced." });
    }

    const result = await saveJournalEntry(rows, sessionId, prompt);
    if (result.status === "success") {
      try { clearOrchestratorSession(sessionId); } catch (e) { /* non-fatal */ }
      return res.status(200).json({
        success: true,
        message: result.message,
        clearedSession: true,
        createdAccounts: check.newAccounts,
        ...(document
          ? { document: { docType, number: document.number, filename: document.filename, url: document.url } }
          : {})
      });
    }

    return res.status(500).json({ success: false, error: result.message || "Save failed." });

  } catch (err) {
    console.error("❌ FULL ERROR in confirmAndSaveEntry:", err);
    return res.status(500).json({ error: "Failed to confirm and save journal entry." });
  }
};
