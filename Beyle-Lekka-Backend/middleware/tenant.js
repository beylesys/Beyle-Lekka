// middleware/tenant.js
import { randomUUID } from "crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function tenantStub() {
  return async (req, res, next) => {
    try {
      const dbKind = (process.env.DB || "sqlite").toLowerCase();

      // --- Correlation id for logs (optional but useful)
      const rid = req.headers["x-request-id"] || randomUUID();
      req.requestId = String(rid);
      res.setHeader("X-Request-Id", req.requestId);

      // --- Resolve requested tenant
      const rawHdr = req.headers["x-workspace-id"];
      const raw = rawHdr && String(rawHdr).trim();

      // Default workspace (only in dev/non-production if nothing was provided)
      const envDefault =
        process.env.WORKSPACE_ID ||
        process.env.DEFAULT_SESSION_ID ||
        (process.env.NODE_ENV !== "production" ? "S-DEV" : "");

      // --- “ALL” scope gate
      const wantsAll = !!raw && raw.toUpperCase() === "ALL";

      // Require an admin key for ALL scope (in all environments)
      const providedAdminKey = req.headers["x-admin-key"]
        ? String(req.headers["x-admin-key"])
        : undefined;

      const keyMatches =
        !!process.env.DEV_ADMIN_KEY &&
        providedAdminKey === process.env.DEV_ADMIN_KEY;

      // In production: also require superadmin role to use ALL
      const isSuperadmin =
        !!req.user?.roles?.includes?.("superadmin");

      const allowAll =
        wantsAll &&
        keyMatches &&
        (process.env.NODE_ENV !== "production" || isSuperadmin);

      // Hard deny ALL scope if not allowed
      if (wantsAll && !allowAll) {
        return res
          .status(403)
          .json({ ok: false, error: "forbidden_all_scope" });
      }

      // If ALL scope is active, keep it READ-ONLY by default
      const allowAllWrites = process.env.ALLOW_ALL_WRITES === "true";
      if (wantsAll && allowAll && !SAFE_METHODS.has(req.method) && !allowAllWrites) {
        return res
          .status(405)
          .json({ ok: false, error: "read_only_all_scope" });
      }

      // --- Determine the active session id for this request
      // If ALL is active, we use null (read paths must handle this; write paths must reject).
      const sid = wantsAll && allowAll ? null : (raw || envDefault);

      // For safety in prod, require a tenant header or explicit default
      if (!wantsAll && !sid) {
        return res
          .status(400)
          .json({ ok: false, error: "workspace_required" });
      }

      // Attach to request for downstream code
      req.sessionId = sid;                 // used in WHERE clauses
      req.sessionIdForInsert = sid;        // REQUIRED for inserts; controllers must reject if null
      req.tenant = {
        id: sid,
        isAll: wantsAll,
        allowAll,
        allowAllWrites,
      };

      // --- Postgres: set per-transaction variables for optional RLS
      if (dbKind === "postgres") {
        const { query } = await import("../services/db.js");

        // We use set_config() so you don't need to predeclare custom GUCs.
        // - app.allow_all: 'on' | 'off'
        // - app.session_id: tenant id or empty
        await query("SELECT set_config('app.allow_all', $1, true)", [
          allowAll ? "on" : "off",
        ]);

        // If sid is null (ALL), store empty string. Policies should check allow_all first.
        const sidForGuc = sid ?? "";
        await query("SELECT set_config('app.session_id', $1, true)", [
          String(sidForGuc),
        ]);
      }

      return next();
    } catch (err) {
      // Fail closed
      console.error("[tenantStub] middleware error:", err);
      return res.status(500).json({ ok: false, error: "tenant_middleware_failed" });
    }
  };
}
