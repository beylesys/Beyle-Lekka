// controllers/orchestrateController.js
import { inferJournalEntriesFromPrompt } from "../utils/mergedInferAccountingFromPrompt.js";
import { classifyPromptType } from "../utils/classifyPromptType.js";
import { validateAndPreparePreview, buildLedgerView } from "../utils/jeCore.js";

// ---------------- In-memory transaction memory per session ----------------
const sessionMemory = Object.create(null);

function getMem(sessionId) {
  if (!sessionMemory[sessionId]) {
    sessionMemory[sessionId] = {
      rootPrompt: null,
      answers: [],
      clarifications: [],
      lastStatus: "idle",
      lastDocType: null,
      draft: { documentFields: null, journal: null },
      updatedAt: Date.now()
    };
  }
  return sessionMemory[sessionId];
}

function resetMem(sessionId) {
  delete sessionMemory[sessionId];
}

function buildCombinedPrompt(mem) {
  const parts = [];
  if (mem.rootPrompt) parts.push(`Original request:\n${mem.rootPrompt}`);
  if (Array.isArray(mem.answers) && mem.answers.length > 0) {
    const bullets = mem.answers.map((a) => `- ${a}`).join("\n");
    parts.push(`Additional details from user:\n${bullets}`);
  }
  if (mem.draft && mem.draft.documentFields) {
    const pretty = JSON.stringify(mem.draft.documentFields, null, 2);
    parts.push(`Known document fields so far (from preview):\n${pretty}`);
  }
  parts.push(
    "Use ALL details above as a single transaction. If any critical field is still missing, ask ONE concise clarification."
  );
  return parts.join("\n\n");
}

// ----- helpers for PREVIEW-ONLY manual edit flow -----
function applyEdits(journal, edits) {
  if (!Array.isArray(journal)) return [];
  if (!edits || (typeof edits !== "object" && !Array.isArray(edits))) return journal;

  const clone = journal.map((r) => ({ ...r }));
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (!e || !Number.isInteger(e.index)) continue;
      const i = e.index;
      if (!clone[i]) continue;
      const t = clone[i];
      if (typeof e.account === "string") t.account = e.account.trim();
      if (typeof e.narration === "string") t.narration = e.narration;
      if (e.debit != null) t.debit = Number(e.debit);
      if (e.credit != null) t.credit = Number(e.credit);
      if (typeof e.date === "string") t.date = e.date;
    }
  } else {
    // object form { [index]: { ...patch } }
    const keys = Object.keys(edits);
    for (const k of keys) {
      const i = Number(k);
      if (!Number.isInteger(i) || !clone[i]) continue;
      const patch = edits[k];
      if (!patch || typeof patch !== "object") continue;
      const t = clone[i];
      if (typeof patch.account === "string") t.account = patch.account.trim();
      if (typeof patch.narration === "string") t.narration = patch.narration;
      if (patch.debit != null) t.debit = Number(patch.debit);
      if (patch.credit != null) t.credit = Number(patch.credit);
      if (typeof patch.date === "string") t.date = patch.date;
    }
  }
  return clone;
}

function applyDocFieldEdits(currentDF, docType, docFieldEdits) {
  if (!docFieldEdits || typeof docFieldEdits !== "object") return currentDF;
  if (!docType || docType === "none") return currentDF;
  const src =
    docType === "payment_voucher"
      ? (docFieldEdits.payment_voucher || docFieldEdits.voucher || null)
      : docFieldEdits[docType] || null;
  if (!src) return currentDF;
  const base = (currentDF && typeof currentDF === "object") ? currentDF : {};
  const existing = base[docType] || {};
  return { ...base, [docType]: { ...existing, ...src } };
}

// ⬅️ Exported so confirm controller can clear memory on success
export const clearOrchestratorSession = (sessionId = "default-session") => {
  resetMem(sessionId);
};

// ---------------- Controller ----------------
export const orchestratePrompt = async (req, res) => {
  try {
    const {
      prompt,
      sessionId = "default-session",
      resetSession = false,
      // NEW: preview-only manual edits
      edits,                // optional: array[{index, ...}] or object { [index]: patch }
      docFieldEdits         // optional: { invoice|receipt|payment_voucher: { ... } } (shallow merge)
    } = req.body || {};

    console.log("📥 Incoming Prompt:", prompt);
    console.log("🧾 Session ID:", sessionId, " resetSession:", !!resetSession);

    if (resetSession) resetMem(sessionId);
    const mem = getMem(sessionId);

    // --------- Manual PREVIEW edit path (no LLM, no save) ---------
    // Allow calling orchestrate with ONLY edits/docFieldEdits to re-preview current draft
    const hasEdits = !!edits;
    const hasDocFieldEdits = !!docFieldEdits;
    const hasDraft = !!(mem.draft && Array.isArray(mem.draft.journal) && mem.draft.journal.length > 0);

    if ((hasEdits || hasDocFieldEdits) && hasDraft) {
      // merge document field edits into draft (optional)
      if (hasDocFieldEdits) {
        const newDF = applyDocFieldEdits(mem.draft.documentFields || {}, mem.lastDocType || "none", docFieldEdits);
        mem.draft.documentFields = newDF;
      }
      // apply line edits into draft journal (optional)
      const edited = hasEdits ? applyEdits(mem.draft.journal, edits) : mem.draft.journal;

      const check = await validateAndPreparePreview(edited, { allowFutureDates: false });
      if (!check.ok) {
        return res.status(200).json({
          success: false,
          status: "invalid",
          errors: check.errors,
          warnings: check.warnings,
          promptType: mem.lastDocType || null
        });
      }

      mem.draft.journal = check.normalized;
      mem.lastStatus = "preview";
      mem.updatedAt = Date.now();

      const ledgerView = buildLedgerView(check.normalized);

      return res.status(200).json({
        success: true,
        status: "preview",
        promptType: mem.lastDocType || null,
        journal: check.normalized,
        ledgerView,
        explanation: "Review and confirm the journal.",
        newAccounts: check.newAccounts,
        warnings: check.warnings,
        docType: mem.lastDocType || "none",
        documentFields: mem.draft.documentFields || {},
        fallbackUsed: null
      });
    }

    // --------- Normal NL flow (LLM + memory) ---------
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      // If no prompt and no edits path above → error
      return res.status(400).json({
        success: false,
        status: "error",
        message: "Prompt cannot be empty (or provide 'edits' for preview re-render)."
      });
    }

    // root vs follow-up
    if (mem.rootPrompt === null) {
      mem.rootPrompt = prompt.trim();
      mem.answers = [];
      mem.clarifications = [];
      mem.lastStatus = "pending";
      mem.lastDocType = null;
      mem.draft = { documentFields: null, journal: null };
    } else {
      mem.answers.push(prompt.trim());
    }
    mem.updatedAt = Date.now();

    const combinedPrompt = buildCombinedPrompt(mem);

    const classifiedType = await classifyPromptType(combinedPrompt, mem.clarifications);
    const docTypeHint = (mem.lastDocType && mem.lastDocType !== "none") ? mem.lastDocType : classifiedType;

    const inferred = await inferJournalEntriesFromPrompt(combinedPrompt, docTypeHint);

    if (inferred && inferred.status === "followup_needed") {
      const question = inferred.clarification || "Please provide the missing detail.";
      mem.clarifications.push(question);
      mem.lastStatus = "followup_needed";
      mem.lastDocType = inferred.docType || mem.lastDocType || "none";
      mem.updatedAt = Date.now();

      return res.status(200).json({
        success: true,
        status: "followup_needed",
        clarification: question,
        docType: mem.lastDocType || "none",
        promptType: docTypeHint || classifiedType || null,
        fallbackUsed: inferred.fallbackUsed
      });
    }

    if (!inferred || inferred.status !== "success" || !Array.isArray(inferred.journal)) {
      mem.lastStatus = "invalid";
      mem.updatedAt = Date.now();
      return res.status(200).json({
        success: false,
        status: inferred?.status || "invalid",
        error: inferred?.message || "Could not infer a valid journal from the prompt.",
        promptType: docTypeHint || classifiedType || null,
        fallbackUsed: inferred?.fallbackUsed
      });
    }

    const check = await validateAndPreparePreview(inferred.journal, { allowFutureDates: false });
    if (!check.ok) {
      mem.lastStatus = "invalid";
      mem.updatedAt = Date.now();
      return res.status(200).json({
        success: false,
        status: "invalid",
        errors: check.errors,
        warnings: check.warnings,
        promptType: docTypeHint || classifiedType || null
      });
    }

    const ledgerView = buildLedgerView(check.normalized);

    const docType = (inferred && typeof inferred.docType === "string") ? inferred.docType : "none";
    const documentFields =
      (inferred && inferred.documentFields && typeof inferred.documentFields === "object")
        ? inferred.documentFields
        : {};

    mem.lastStatus = "preview";
    mem.lastDocType = docType || mem.lastDocType || "none";
    mem.draft = { documentFields, journal: check.normalized };
    mem.updatedAt = Date.now();

    return res.status(200).json({
      success: true,
      status: "preview",
      promptType: docTypeHint || classifiedType || null,
      journal: check.normalized,
      ledgerView,
      explanation: inferred.explanation || "Review and confirm the journal.",
      newAccounts: check.newAccounts,
      warnings: check.warnings,
      docType: mem.lastDocType || "none",
      documentFields: mem.draft.documentFields || {},
      fallbackUsed: inferred?.fallbackUsed
    });

  } catch (err) {
    console.error("🚨 Orchestration Error:", err);
    const sid = (req.body && req.body.sessionId) || "default-session";
    getMem(sid).lastStatus = "error";
    return res.status(500).json({ success: false, error: "Internal server error during orchestration." });
  }
};
