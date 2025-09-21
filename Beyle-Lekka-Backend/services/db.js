// services/db.js
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * Resolve the SQLite path so the server and migration script use the SAME file.
 * Priority:
 *   1) SQLITE_FILE  (used by migrations and .env in your repo)
 *   2) DB_FILE      (legacy/alias)
 *   3) ./beylelekka.db (stable default used by migrations)
 */
const RESOLVED_DB_FILE = (() => {
  const candidate =
    process.env.SQLITE_FILE ||
    process.env.DB_FILE ||
    "./beylelekka.db";
  return path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
})();

// Ensure directory exists
fs.mkdirSync(path.dirname(RESOLVED_DB_FILE), { recursive: true });

// Open DB
const sqlite = new Database(RESOLVED_DB_FILE);

// Pragmas tuned for durability + decent perf
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
// Optional perf tweaks (safe for most workloads):
// sqlite.pragma("temp_store = MEMORY");
// sqlite.pragma("cache_size = -16000"); // ~16MB cache

console.log(`[db] Using SQLite file: ${RESOLVED_DB_FILE}`);

/* ------------------------- Placeholder Adapters ------------------------- *
 * Supports:
 *   - Numeric placeholders: $1, $2, ...   (converted to '?' with ordered params)
 *   - Positional '?'
 *   - Named bindings: :name, @name, $name  (passed through when params is object)
 * Falls back safely if caller passes no params.
 * ----------------------------------------------------------------------- */

// Map $1,$2,... to '?' and produce ordered param array
function remapNumericPlaceholders(sql, paramsArray) {
  const ordered = [];
  const s = String(sql).replace(/\$([1-9]\d*)/g, (_, n) => {
    const idx = Number(n) - 1;
    ordered.push(paramsArray?.[idx]);
    return "?";
  });
  return { s, p: ordered };
}

// Main adapter: normalizes (sql, params) into (stringSQL, boundParams)
function adapt(sql, params) {
  const s0 = String(sql);

  // Array params → either $n mapping, or passthrough for '?'
  if (Array.isArray(params)) {
    if (/\$[1-9]\d*/.test(s0)) {
      return remapNumericPlaceholders(s0, params);
    }
    if (/\?/.test(s0)) {
      return { s: s0, p: params };
    }
    // If there are no placeholders, drop params to avoid binding errors
    const hasNamed = /[:@\$][A-Za-z_][A-Za-z0-9_]*/.test(s0);
    if (!hasNamed) return { s: s0, p: [] };
    // If there ARE named placeholders but we got an array, better-sqlite3 will error;
    // still pass through to surface a clear error at runtime.
    return { s: s0, p: params };
  }

  // Object params → assume named bindings (:name | @name | $name)
  if (params && typeof params === "object") {
    return { s: s0, p: params };
  }

  // No params
  return { s: s0, p: [] };
}

/**
 * query(sql, params)
 * - SELECT/PRAGMA/WITH → returns { rows }
 * - INSERT/UPDATE/DELETE → returns { rows: [], lastInsertRowid, changes }
 * Throws on error and logs concise diagnostics (SQL head + param keys).
 */
export async function query(sql, params = []) {
  const { s, p } = adapt(sql, params);
  try {
    const isQuery = /^\s*(select|pragma|with)\b/i.test(s);
    const stmt = sqlite.prepare(s);
    if (isQuery) {
      const rows = stmt.all(p);
      return { rows };
    } else {
      const info = stmt.run(p);
      return { rows: [], lastInsertRowid: info.lastInsertRowid, changes: info.changes };
    }
  } catch (err) {
    // Helpful, privacy-aware diagnostics
    console.error("[db] Error:", err.message);
    console.error("[db] SQL (head):", String(sql).slice(0, 140).replace(/\s+/g, " "));
    if (Array.isArray(params)) {
      console.error("[db] Params (array length):", params.length);
    } else if (params && typeof params === "object") {
      console.error("[db] Params (keys):", Object.keys(params));
    } else {
      console.error("[db] Params: []");
    }
    console.error("[db] File:", RESOLVED_DB_FILE);
    throw err;
  }
}

// Simple async-friendly transaction wrapper
export async function withTx(fn) {
  sqlite.exec("BEGIN");
  try {
    const result = await fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (err) {
    try { sqlite.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

export function rawDb() { return sqlite; }

export default { query, withTx, rawDb };
