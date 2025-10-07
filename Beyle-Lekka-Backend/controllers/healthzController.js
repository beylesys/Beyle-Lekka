// controllers/healthzController.js
// ESM version, exports both named and default.

import Flags, { all as getFlagsAll } from "../utils/flags.js";

/**
 * GET /healthz
 * Reports app flags and a quick DB health probe (works for sqlite, knex(pg), and pools).
 */
export async function getHealthz(req, res) {
  const flags = getFlagsAll(); // snapshot of flags
  let db = null;
  let dbDialect = null;
  let dbStatus = "skip";
  let latencyMs = null;

  try {
    // Convention: app.set('db', dbHandle)
    db = req.app && req.app.get && req.app.get("db");
  } catch {
    /* ignore */
  }

  if (db) {
    try {
      const t0 = process.hrtime.bigint();
      if (typeof db.prepare === "function") {
        // better-sqlite3
        db.prepare("select 1 as ok").get();
        dbDialect = "sqlite";
      } else if (typeof db.raw === "function") {
        // knex (pg/sqlite/mysql)
        await db.raw("select 1 as ok");
        dbDialect = (db.client && db.client.config && db.client.config.client) || "knex";
      } else if (typeof db.query === "function") {
        // generic pool (pg / mysql2)
        await db.query("select 1 as ok");
        dbDialect = "pool";
      } else {
        dbDialect = "unknown";
      }
      const t1 = process.hrtime.bigint();
      latencyMs = Number(t1 - t0) / 1e6;
      dbStatus = "ok";
    } catch {
      dbStatus = "error";
      dbDialect = dbDialect || "unknown";
    }
  }

  return res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    flags,
    db: { status: dbStatus, dialect: dbDialect, latency_ms: latencyMs },
  });
}

export default { getHealthz };
