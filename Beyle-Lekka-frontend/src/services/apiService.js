// src/services/apiService.js
import axios from "axios";

/**
 * Compute a safe absolute base URL for the API.
 * Rules:
 *   - If input is absolute http(s) and does NOT contain "/api", append "/api".
 *   - If input is a path (e.g., "api" or "/api"), force leading slash and ensure it starts with "/api".
 *   - Always return an ABSOLUTE URL (origin + path) so the browser never makes a relative request.
 */
function computeAbsoluteBase(rawInput) {
  const DEFAULT_PREFIX = "/api";
  const raw = (rawInput || "").toString().trim();

  // 1) Absolute http(s) base given?
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (!/\/api(\/|$)/i.test(u.pathname)) {
      u.pathname = (u.pathname.replace(/\/+$/, "") + DEFAULT_PREFIX).replace(/\/{2,}/g, "/");
    }
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  }

  // 2) Path-style base (proxy through the frontend)
  let path = `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  if (!/^\/api(\/|$)/i.test(path)) {
    path = (DEFAULT_PREFIX + (path === "/" ? "" : path)).replace(/\/{2,}/g, "/");
  }
  path = path.replace(/\/+$/, "");

  const abs = new URL(path || DEFAULT_PREFIX, window.location.origin);
  return abs.toString();
}

/**
 * Resolve base from (in order):
 * - localStorage.apiBaseUrl (handy for quick overrides)
 * - Vite env VITE_API_BASE_URL (prod/preview)
 * - dev default http://localhost:3000/api, prod default '/api'
 */
const computedDefault = (import.meta?.env?.DEV ? "http://localhost:3000/api" : "/api");
const rawBase =
  (typeof localStorage !== "undefined" && localStorage.getItem("apiBaseUrl")) ||
  import.meta.env.VITE_API_BASE_URL ||
  computedDefault;

export const BASE_URL = computeAbsoluteBase(rawBase);

// One-time log in dev to confirm what we're using
if (import.meta?.env?.DEV) {
  // eslint-disable-next-line no-console
  console.info("[api] ABSOLUTE BASE_URL =", BASE_URL);
}

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err?.response?.data?.error || err?.message || "Request failed";
    return Promise.reject(new Error(msg));
  }
);

function handle(method, url, data, config) {
  const cfg = { ...(config || {}) };
  if (method === "get") {
    return api.get(url, { params: data, ...cfg }).then((r) => r.data);
  }
  return api[method](url, data, cfg).then((r) => r.data);
}

export function makeIdemKey(seed = "") {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  const s = (seed || "").toString().slice(0, 64);
  return `idem_${ts}_${rnd}_${s}`;
}

/**
 * Orchestrate — supports BOTH modes:
 *  1) NL mode (chat):   requires a non-empty `prompt`.
 *  2) Structured mode (extraction): requires `fields` (and/or `source: "extraction"`),
 *     no prompt needed. Passes through `docType`, `fields`, `source`, `docFieldEdits`, `edits`, `debug`.
 *
 * This function *does not* drop unknown keys. It forwards what the server needs.
 */
export async function orchestratePrompt(params = {}) {
  const {
    // Common
    sessionId = "default-session",
    idempotencyKey,
    debug,
    meta,

    // NL mode
    prompt,

    // Structured mode
    docType,
    fields,
    source,
    docFieldEdits,
    edits,
  } = params;

  // Detect structured mode (document extraction / edits)
  const hasFields =
    fields && typeof fields === "object" && Object.keys(fields).length > 0;
  const structuredMode =
    source === "extraction" || hasFields ||
    (docFieldEdits && docType && typeof docFieldEdits === "object");

  const payload = {
    sessionId,
  };

  if (structuredMode) {
    if (docType) payload.docType = docType;
    if (hasFields) payload.fields = fields;
    payload.source = source || "extraction"; // default when not provided
    if (docFieldEdits) payload.docFieldEdits = docFieldEdits;
    if (edits) payload.edits = edits;
    if (debug !== undefined) payload.debug = debug;
    if (meta !== undefined) payload.meta = meta;
    payload.idempotencyKey =
      idempotencyKey ||
      makeIdemKey(`${docType || "doc"}:${JSON.stringify(fields || {}).slice(0, 128)}`);
    return handle("post", "/orchestratePrompt", payload);
  }

  // NL mode (chat) — prompt is mandatory (backwards compatible with your previous behavior)
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt is required");
  }
  payload.prompt = prompt.trim();
  if (docType) payload.docType = docType; // hint is allowed for NL
  if (debug !== undefined) payload.debug = debug;
  if (meta !== undefined) payload.meta = meta;
  payload.idempotencyKey = idempotencyKey || makeIdemKey(payload.prompt);
  return handle("post", "/orchestratePrompt", payload);
}

/** Convenience wrapper for structured (extraction) flow. */
export async function orchestrateFromExtraction({
  sessionId = "default-session",
  docType = "none",
  fields = {},
  idempotencyKey,
  debug,
}) {
  return orchestratePrompt({
    sessionId,
    docType,
    fields,
    source: "extraction",
    idempotencyKey,
    debug,
  });
}

/** Confirm a preview snapshot produced by orchestrate (needs previewId and hash). */
export async function confirmFromPreview({
  previewId,
  hash,
  sessionId = "default-session",
  idempotencyKey,
}) {
  if (!previewId || !hash) throw new Error("previewId and hash are required");
  return handle("post", "/confirmAndSaveEntry", {
    previewId,
    hash,
    idempotencyKey: idempotencyKey || makeIdemKey(previewId),
    sessionId,
  });
}

/** Legacy confirm path (direct journal post) */
export const confirmEntry = (payload) => handle("post", "/confirmAndSaveEntry", payload);

/** Ledger view (DB-backed on server) */
export const fetchLedgerView = (sessionId) => handle("post", "/getLedgerView", { sessionId });

/** Update a single ledger entry (inline edit) */
export const updateLedgerEntry = (payload) => handle("post", "/ledger/update", payload);

/** Optional memory getter (if exposed) */
export const getMemoryBySession = (sessionId) => handle("post", "/getMemory", { sessionId });

/** Server-side reports */
export const getTrialBalance = (asOf) => handle("get", "/reports/trial-balance", { asOf });
export const getPL = (from, to) => handle("get", "/reports/pl", { from, to });
export const getBalanceSheet = (asOf) => handle("get", "/reports/bs", { asOf });

/** Document upload + extraction */
export async function uploadDocument(file, opts = {}) {
  const fd = new FormData();
  fd.append("file", file);
  const params = {};
  if (opts.force) params.force = 1;
  return api
    .post("/documents/upload", fd, {
      params,
      headers: { "Content-Type": "multipart/form-data" },
    })
    .then((r) => r.data);
}

/** Bank reconciliation */
export async function importBankCSV(file) {
  const fd = new FormData();
  fd.append("file", file);
  return api
    .post("/bankreco/import", fd, { headers: { "Content-Type": "multipart/form-data" } })
    .then((r) => r.data);
}

export const fetchRecoSuggestions = (params) => handle("get", "/bankreco/suggestions", params);
export const confirmRecoMatch = (bankLineId, ledgerEntryId) =>
  handle("post", "/bankreco/match", { bankLineId, ledgerEntryId });

export { api };
