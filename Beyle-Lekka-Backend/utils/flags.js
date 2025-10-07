// utils/flags.js
// ESM-compatible feature flags & helpers, plus global kill-switch middleware.
// Works with:
//   import Flags from "./utils/flags.js"
//   import { bool, str, num, json, all, getFlags, enforceKillSwitches } from "./utils/flags.js"

function parseBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function str(name, fallback = "") {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function num(name, fallback = 0) {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback = false) {
  return parseBool(process.env[name], fallback);
}

function json(name, fallback = null) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** Snapshot all well-known flags. */
function all() {
  return Object.freeze({
    NODE_ENV: str("NODE_ENV", "development"),
    READ_ONLY: bool("READ_ONLY", false),
    MAINTENANCE_MODE: bool("MAINTENANCE_MODE", false),
    ENABLE_METRICS: bool("ENABLE_METRICS", true),
    ALLOW_ALL_WRITES: bool("ALLOW_ALL_WRITES", false), // used by tenant.js
    CORS_ALLOWED_ORIGINS: str("CORS_ALLOWED_ORIGINS", ""),
    SERVICE_NAME: str("SERVICE_NAME", "beyle-lekka-backend"),
  });
}

function getFlags() { return all(); }

/** Express middleware: global maintenance/read-only gates. */
function enforceKillSwitches(req, res, next) {
  const F = all();
  if (F.MAINTENANCE_MODE) {
    return res.status(503).json({ ok: false, error: "maintenance_mode" });
  }
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (F.READ_ONLY && WRITE_METHODS.has(req.method) && !F.ALLOW_ALL_WRITES) {
    return res.status(403).json({ ok: false, error: "read_only_mode" });
  }
  return next();
}

const Flags = Object.freeze({ bool, str, num, json, all, getFlags, enforceKillSwitches });
export { bool, str, num, json, all, getFlags, enforceKillSwitches };
export default Flags;
