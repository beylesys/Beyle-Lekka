// src/services/apiService.js
import axios from "axios";

/**
 * Compute a safe absolute base URL for the API.
 * Rules:
 *   - If input is absolute http(s) and does NOT contain "/api", append "/api".
 *   - If input is a path (e.g., "api" or "/api"), force leading slash and ensure it starts with "/api".
 *   - Always return an ABSOLUTE URL (origin + path).
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

  const origin = (typeof window !== "undefined" && window.location && window.location.origin)
    ? window.location.origin
    : "http://localhost";
  const abs = new URL(path || DEFAULT_PREFIX, origin);
  return abs.toString();
}

/** Base URL resolution (localStorage override → env → sensible defaults) */
const computedDefault = (import.meta?.env?.DEV ? "http://localhost:3000/api" : "/api");
const rawBase =
  (typeof localStorage !== "undefined" && localStorage.getItem("apiBaseUrl")) ||
  import.meta.env.VITE_API_BASE_URL ||
  computedDefault;

export const BASE_URL = computeAbsoluteBase(rawBase);

/** Runtime override helpers for base URL (handy in QA) */
export function setApiBaseUrl(urlOrPath) {
  const abs = computeAbsoluteBase(urlOrPath);
  try { localStorage.setItem("apiBaseUrl", abs); } catch {}
  api.defaults.baseURL = abs;
  return abs;
}
export function getApiBaseUrl() {
  try { return localStorage.getItem("apiBaseUrl") || BASE_URL; } catch { return BASE_URL; }
}

// One-time log in dev to confirm what we're using
if (import.meta?.env?.DEV) {
  // eslint-disable-next-line no-console
  console.info("[api] ABSOLUTE BASE_URL =", BASE_URL);
}

/** Workspace helpers so other modules/components can read/set the active tenant */
const ENV_WORKSPACE = (import.meta?.env?.VITE_WORKSPACE_ID || "").toString().trim();
const DEV_DEFAULT = import.meta?.env?.DEV ? "S-DEV" : "default-session";
const DEFAULT_WORKSPACE_ID = ENV_WORKSPACE || DEV_DEFAULT;

export function getWorkspaceId() {
  try {
    const sid = localStorage.getItem("workspaceId");
    if (sid && typeof sid === "string") return sid;
  } catch {}
  return DEFAULT_WORKSPACE_ID;
}
export function setWorkspaceId(sid) {
  try {
    if (sid && typeof sid === "string") {
      localStorage.setItem("workspaceId", sid);
    }
  } catch {}
}

/** Admin key helpers (for /api/admin/*) */
export function getAdminKey() {
  try {
    return localStorage.getItem("adminKey") || import.meta?.env?.VITE_DEV_ADMIN_KEY || "";
  } catch {
    return import.meta?.env?.VITE_DEV_ADMIN_KEY || "";
  }
}
export function setAdminKey(k) {
  try {
    if (typeof k === "string") localStorage.setItem("adminKey", k);
  } catch {}
}

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
});

/**
 * REQUEST interceptor:
 * - Inject X-Workspace-Id on EVERY request (supports "ALL" for admin reads).
 *   Priority: explicit header on config > body.sessionId/params.sessionId > localStorage > env/default.
 * - Auto-inject X-Admin-Key for /api/admin/* when available.
 */
api.interceptors.request.use((config) => {
  const h = (config.headers || {});
  const explicit =
    h["X-Workspace-Id"] || h["x-workspace-id"] || h["X-workspace-id"] || null;

  // Try to detect from body/params when present
  const fromData =
    (config.data && typeof config.data === "object" && config.data.sessionId) || null;
  const fromParams =
    (config.params && typeof config.params === "object" && config.params.sessionId) || null;

  const sid = explicit || fromData || fromParams || getWorkspaceId() || DEFAULT_WORKSPACE_ID;
  if (sid) {
    h["X-Workspace-Id"] = sid; // "ALL" is acceptable for read-only endpoints
  }

  // Auto-attach admin key for admin routes
  const urlPath = String(config.url || "");
  const isAdminCall = urlPath.startsWith("/admin") || urlPath.includes("/api/admin");
  if (isAdminCall) {
    const key = getAdminKey();
    if (key) h["X-Admin-Key"] = key;
  }

  config.headers = h;
  return config;
});

/** RESPONSE error normalization (keep your behavior) */
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
 *  1) NL mode (chat)
 *  2) Structured mode (extraction)
 *
 * Notes:
 * - We still pass sessionId in body for backward-compat, but server relies on the header.
 * - If `debug` is truthy, also send `X-Debug: 1` (admin-only on server).
 */
export async function orchestratePrompt(params = {}) {
  const {
    // Common
    sessionId = getWorkspaceId(),
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

  const cfg = debug ? { headers: { "X-Debug": "1" } } : undefined;

  // Detect structured mode
  const hasFields = fields && typeof fields === "object" && Object.keys(fields).length > 0;
  const structuredMode =
    source === "extraction" || hasFields ||
    (docFieldEdits && docType && typeof docFieldEdits === "object");

  const payload = { sessionId };

  if (structuredMode) {
    if (docType) payload.docType = docType;
    if (hasFields) payload.fields = fields;
    payload.source = source || "extraction";
    if (docFieldEdits) payload.docFieldEdits = docFieldEdits;
    if (edits) payload.edits = edits;
    if (debug !== undefined) payload.debug = debug; // keep body flag too
    if (meta !== undefined) payload.meta = meta;
    payload.idempotencyKey =
      idempotencyKey ||
      makeIdemKey(`${docType || "doc"}:${JSON.stringify(fields || {}).slice(0, 128)}`);
    return handle("post", "/orchestratePrompt", payload, cfg);
  }

  // NL mode (chat)
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt is required");
  }
  payload.prompt = prompt.trim();
  if (docType) payload.docType = docType; // hint allowed
  if (debug !== undefined) payload.debug = debug;
  if (meta !== undefined) payload.meta = meta;
  payload.idempotencyKey = idempotencyKey || makeIdemKey(payload.prompt);
  return handle("post", "/orchestratePrompt", payload, cfg);
}

/** Convenience wrapper for structured (extraction) flow. */
export async function orchestrateFromExtraction({
  sessionId = getWorkspaceId(),
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
  sessionId = getWorkspaceId(),
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
export const fetchLedgerView = (sessionId = getWorkspaceId()) =>
  handle("post", "/getLedgerView", { sessionId });

/** Update a single ledger entry (inline edit) */
export const updateLedgerEntry = (payload) => handle("post", "/ledger/update", payload);

/** Optional memory getter (if exposed) */
export const getMemoryBySession = (sessionId = getWorkspaceId()) =>
  handle("post", "/getMemory", { sessionId });

/** Server-side reports (GET) — header carries the workspace automatically */
export const getTrialBalance  = (asOf)        => handle("get", "/reports/trial-balance", { asOf });
export const getPL            = (from, to)    => handle("get", "/reports/pl",            { from, to });
export const getBalanceSheet  = (asOf)        => handle("get", "/reports/bs",            { asOf });

/** Document upload + extraction */
export async function uploadDocument(file, opts = {}) {
  const fd = new FormData();
  fd.append("file", file);
  const params = {};
  if (opts.force) params.force = 1;
  if (opts.debug) params.debug = 1;
  return api
    .post("/documents/upload", fd, {
      params,
      headers: { "Content-Type": "multipart/form-data" }, // X-Workspace-Id added by interceptor
    })
    .then((r) => r.data);
}

/** Bank reconciliation */
export async function importBankCSV(file, bankAccountId) {
  if (!bankAccountId) throw new Error("bankAccountId is required");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("bankAccountId", bankAccountId); // <-- REQUIRED by backend
  return api
    .post("/bankreco/import", fd, { headers: { "Content-Type": "multipart/form-data" } })
    .then((r) => r.data);
}
export const fetchRecoSuggestions = (params) => handle("get", "/bankreco/suggestions", params);
export const confirmRecoMatch = (bankLineId, ledgerEntryId) =>
  handle("post", "/bankreco/match", { bankLineId, ledgerEntryId });

/** Admin helpers (optional, but nice to have in dev tools) */
export const admin = {
  listSessions() {
    return api.get("/admin/sessions").then((r) => r.data);
  },
  moveSession(from, to) {
    return api.post("/admin/move-session", { from, to }).then((r) => r.data);
  },
  setKey: setAdminKey,
  getKey: getAdminKey,
};

export { api };
