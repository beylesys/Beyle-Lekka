// src/services/apiService.js
import axios from "axios";

/**
 * Base URL resolution:
 * - localStorage.apiBaseUrl (handy for quick overrides)
 * - Vite env: VITE_API_BASE_URL (use this in production)
 * - fallback to '/api' so Vite's proxy forwards to http://localhost:3000
 */
export const BASE_URL =
  (typeof localStorage !== "undefined" && localStorage.getItem("apiBaseUrl")) ||
  import.meta.env.VITE_API_BASE_URL ||
  "/api";

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 120000,
  headers: { "Content-Type": "application/json" },
});

// Generic request handler (returns raw backend JSON)
export const handle = async (method, endpoint, data = {}) => {
  try {
    const res = await api.request({ method, url: endpoint, data });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      `❌ API ${method.toUpperCase()} ${endpoint} failed`,
      status,
      body || err.message
    );
    throw body ?? { error: err.message || "Unknown API error", status };
  }
};

/** ---------- Endpoints ---------- */

/**
 * Orchestrate:
 *  Backward-compatible overloads:
 *    - orchestratePrompt("spent 2500 on petrol", "S-123")
 *    - orchestratePrompt({
 *         prompt: "spent 2500 on petrol",
 *         sessionId: "S-123",
 *         followUpChain?: string[]
 *         // NEW (optional):
 *         edits?: Array<{index:number, account?, debit?, credit?, date?, narration?}> | { [index]: patch }
 *         docFieldEdits?: { invoice?|receipt?|payment_voucher?: object }
 *         resetSession?: boolean
 *       })
 *
 *  Notes:
 *  - You may omit `prompt` when sending only `edits` / `docFieldEdits` to re-preview.
 *  - Shape is kept minimal: undefined keys are not sent.
 */
export const orchestratePrompt = (arg1, arg2) => {
  let payload = {};

  if (typeof arg1 === "object" && arg1 !== null) {
    const {
      prompt,
      sessionId,
      followUpChain,
      // NEW
      edits,
      docFieldEdits,
      resetSession,
    } = arg1;

    if (typeof prompt === "string") payload.prompt = prompt;
    if (typeof sessionId === "string") payload.sessionId = sessionId;
    if (Array.isArray(followUpChain)) payload.followUpChain = followUpChain;

    // Pass-through for preview re-render + session control
    if (edits) payload.edits = edits;
    if (docFieldEdits) payload.docFieldEdits = docFieldEdits;
    if (typeof resetSession === "boolean") payload.resetSession = resetSession;
  } else {
    // Legacy signature (prompt, sessionId)
    payload = { prompt: arg1, sessionId: arg2 };
  }

  return handle("post", "/orchestratePrompt", payload);
};

// Confirm & persist validated ledger entry (expects exact preview `journal`)
export const confirmEntry = (payload) =>
  handle("post", "/confirmAndSaveEntry", payload);

// Fetch the ledger view for a session
export const fetchLedgerView = (sessionId) =>
  handle("post", "/getLedgerView", { sessionId });

// (Only if your backend implements it)
export const getMemoryBySession = (sessionId) =>
  handle("post", "/getMemory", { sessionId });

export { api };
