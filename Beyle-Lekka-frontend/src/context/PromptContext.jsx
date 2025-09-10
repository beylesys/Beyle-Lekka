// src/context/PromptContext.js
import React, { createContext, useContext, useState } from "react";

const PromptContext = createContext();

export const PromptProvider = ({ children }) => {
  const [sessionId] = useState(() => `S-${Date.now()}`);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle"); // 'idle' | 'preview' | 'followup' | 'error'
  const [thread, setThread] = useState([]);
  const [lastResponseType, setLastResponseType] = useState(null);

  /**
   * Accepts:
   *  Backend (new):
   *    {
   *      success,
   *      status: 'preview'|'success'|'followup_needed'|'invalid'|'error',
   *      journal?, normalized?, ledgerView?, explanation?, newAccounts?, warnings?,
   *      docType?, documentFields?
   *    }
   *  Legacy (old):
   *    { prompt, results: [{type, content}, ...], status?, message? }
   */
  const updatePromptSession = (data) => {
    console.log("📥 [updatePromptSession] Raw Data:", data);

    const rawStatus = typeof data?.status === "string" ? data.status.toLowerCase() : "";

    // Prefer 'journal', fallback to 'normalized'
    const normalizedJournal =
      Array.isArray(data?.journal) ? data.journal :
      Array.isArray(data?.normalized) ? data.normalized :
      null;

    // Normalize doc preview payload
    const normalizedDocType =
      typeof data?.docType === "string" ? data.docType : "none";

    const normalizedDocumentFields =
      data?.documentFields && typeof data.documentFields === "object"
        ? data.documentFields
        : {};

    // ---------- FOLLOW-UP MODE ----------
    if (rawStatus === "followup_needed") {
      const entry = {
        kind: "followup",
        clarification: data?.clarification || "Please provide the missing detail.",
        promptType: data?.promptType || null,
        // NEW: carry docType so UI can frame the follow-up properly
        docType: normalizedDocType,
        raw: data
      };
      setThread((prev) => [...prev, entry]);
      setStatus("followup");
      setLastResponseType("followup");
      setPrompt("");
      return;
    }

    // ---------- PREVIEW / SUCCESS MODE ----------
    // Treat 'success' like 'preview' (preview = save contract)
    if ((rawStatus === "preview" || rawStatus === "success") && Array.isArray(normalizedJournal) && normalizedJournal.length >= 2) {
      const entry = {
        kind: "preview",
        journal: normalizedJournal,                 // rows the preview card renders
        ledgerView: data?.ledgerView || "",
        explanation: data?.explanation || "",
        newAccounts: Array.isArray(data?.newAccounts) ? data.newAccounts : [],
        promptType: data?.promptType || null,
        // NEW: doc preview payload from backend
        docType: normalizedDocType,                 // "invoice" | "receipt" | "payment_voucher" | "none"
        documentFields: normalizedDocumentFields,   // { invoice|receipt|payment_voucher: {...} } or {}
        raw: data
      };
      setThread((prev) => [...prev, entry]);
      setStatus("preview");
      setLastResponseType("preview");
      setPrompt("");
      return;
    }

    // ---------- INVALID / BACKEND ERROR ----------
    if (rawStatus === "invalid" || rawStatus === "error" || data?.success === false) {
      const msg =
        data?.error ||
        (Array.isArray(data?.errors) && data.errors.join(", ")) ||
        "Something went wrong. Please try again.";
      const entry = {
        kind: "error",
        message: msg,
        errors: data?.errors || [],
        warnings: data?.warnings || [],
        raw: data
      };
      setThread((prev) => [...prev, entry]);
      setStatus("error");
      setLastResponseType("error");
      setPrompt("");
      return;
    }

    // ---------- LEGACY SHAPE (prompt + results) ----------
    const hasLegacy = data?.prompt && Array.isArray(data?.results);
    if (hasLegacy) {
      const validatedResults = data.results.filter((res) => res?.type && res?.content !== undefined);
      const newEntry = { kind: "legacy", prompt: data.prompt, results: validatedResults, raw: data };

      console.log("📌 Adding New Entry to Thread (legacy):", newEntry);
      setThread((prev) => [...prev, newEntry]);

      if (validatedResults.length > 0) {
        setLastResponseType(validatedResults[0].type);
        console.log("🧠 Last Response Type:", validatedResults[0].type);
      }

      if (rawStatus) setStatus(rawStatus);
      setPrompt("");
      return;
    }

    // ---------- FALLBACK ----------
    // If nothing matched but we have a journal-looking object, try to render preview anyway.
    if ( Array.isArray(normalizedJournal) && normalizedJournal.length >= 2 ) {
      const entry = {
        kind: "preview",
        journal: normalizedJournal,
        ledgerView: data?.ledgerView || "",
        explanation: data?.explanation || "",
        newAccounts: Array.isArray(data?.newAccounts) ? data.newAccounts : [],
        promptType: data?.promptType || null,
        // Try to surface doc payload if present even in odd shapes
        docType: normalizedDocType,
        documentFields: normalizedDocumentFields,
        raw: data
      };
      setThread((prev) => [...prev, entry]);
      setStatus("preview");
      setLastResponseType("preview");
      setPrompt("");
      return;
    }

    // Nothing matched → error
    console.warn("⚠️ Unrecognized response shape, entering error state:", data);
    setStatus("error");
    setLastResponseType("error");
    setPrompt("");
  };

  const resetThread = () => {
    console.log("♻️ [resetThread] Resetting entire thread and context.");
    setThread([]);
    setStatus("idle");
    setPrompt("");
    setLastResponseType(null);
  };

  return (
    <PromptContext.Provider
      value={{
        sessionId,
        prompt,
        setPrompt,
        status,
        setStatus,
        thread,
        setThread,
        updatePromptSession,
        resetThread,
        lastResponseType
      }}
    >
      {children}
    </PromptContext.Provider>
  );
};

export const usePrompt = () => useContext(PromptContext);
