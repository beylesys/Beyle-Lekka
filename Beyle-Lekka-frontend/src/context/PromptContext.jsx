// src/context/PromptContext.js
import React, { createContext, useContext, useState } from "react";

const PromptContext = createContext();

// ---- tiny helpers -----------------------------------------------------------
const isPreviewish = (s) =>
  ["preview", "success", "ok", "ready"].includes(String(s || "").toLowerCase());

const extractJournal = (obj) => {
  if (Array.isArray(obj?.journal)) return obj.journal;
  if (Array.isArray(obj?.normalized)) return obj.normalized;
  if (Array.isArray(obj?.ledgerView?.journal)) return obj.ledgerView.journal;
  return [];
};

const normalizeDocFields = (docType, documentFields) => {
  const dt = typeof docType === "string" ? docType : "none";
  const df = documentFields && typeof documentFields === "object" ? documentFields : {};
  if (dt === "none") return {};
  // Accept both shapes:
  // - { invoice: {...} } already keyed
  // - { number: "...", items: [...] } flattened -> key it under docType
  return df[dt] ? df : { [dt]: df };
};

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
  const updatePromptSession = (dataIn) => {
    // 0) unwrap if someone wrapped as { data: {...} }
    const data =
      dataIn && typeof dataIn === "object" && dataIn.data && !("status" in dataIn)
        ? dataIn.data
        : dataIn;

    console.log("📥 [updatePromptSession] Raw Data:", data);

    const rawStatus = typeof data?.status === "string" ? data.status.toLowerCase() : "";
    const journal = extractJournal(data);
    const docType = typeof data?.docType === "string" ? data.docType : "none";
    const documentFields = normalizeDocFields(docType, data?.documentFields);

    // ---------- FOLLOW-UP MODE ----------
    if (rawStatus === "followup_needed") {
      const entry = {
        kind: "followup",
        clarification: data?.clarification || "Please provide the missing detail.",
        promptType: data?.promptType || null,
        docType,
        raw: data,
      };
      setThread((prev) => [...prev, entry]);
      setStatus("followup");
      setLastResponseType("followup");
      setPrompt("");
      return;
    }

    // ---------- PREVIEW / SUCCESS MODE ----------
    if (isPreviewish(rawStatus) && journal.length >= 1) {
      const entry = {
        kind: "preview",
        journal,
        ledgerView: data?.ledgerView || "",
        explanation: data?.explanation || "",
        newAccounts: Array.isArray(data?.newAccounts) ? data.newAccounts : [],
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
        promptType: data?.promptType || null,
        docType,
        documentFields,
        raw: data,
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
        raw: data,
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
      const validatedResults = data.results.filter(
        (res) => res?.type && res?.content !== undefined
      );
      const newEntry = {
        kind: "legacy",
        prompt: data.prompt,
        results: validatedResults,
        raw: data,
      };

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
    // If we still received a journal-like array, try to render a preview anyway.
    if (journal.length >= 1) {
      const entry = {
        kind: "preview",
        journal,
        ledgerView: data?.ledgerView || "",
        explanation: data?.explanation || "",
        newAccounts: Array.isArray(data?.newAccounts) ? data.newAccounts : [],
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
        promptType: data?.promptType || null,
        docType,
        documentFields,
        raw: data,
      };
      setThread((prev) => [...prev, entry]);
      setStatus("preview");
      setLastResponseType("preview");
      setPrompt("");
      return;
    }

    // Nothing matched → push a raw entry so UI can optionally show it (debug),
    // but mark state as error so callers know it didn't fit known shapes.
    console.warn("⚠️ Unrecognized response shape, storing raw and entering error state:", data);
    setThread((prev) => [...prev, { kind: "raw", raw: data }]);
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
        lastResponseType,
      }}
    >
      {children}
    </PromptContext.Provider>
  );
};

export const usePrompt = () => useContext(PromptContext);
