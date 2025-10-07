// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes/api.js";
import * as DB from "./services/db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as CoA from "./utils/coaService.js";
import adminRoutes from "./routes/admin.js";
import { randomUUID } from "crypto";

/* ---------- Flags & Health ---------- */
import FlagsModule from "./utils/flags.js";
import HealthzModule from "./controllers/healthzController.js";
const { enforceKillSwitches, getFlags } = FlagsModule;
const { getHealthz } = HealthzModule;

/* ---------- Load env; let .env override stray shell vars ---------- */
dotenv.config({ override: true });

/* ---------- resolve __dirname in ESM ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ---------- Environment & Port selection ---------- */
const ENV = process.env.NODE_ENV || "development";
const isProd = ENV === "production";

/**
 * In development we IGNORE any stray shell PORT (e.g., 5173 from Vite)
 * unless you explicitly set BACKEND_PORT. In production we honor platform PORT.
 */
const PORT = Number(
  isProd
    ? (process.env.PORT || process.env.BACKEND_PORT || 3000)
    : (process.env.BACKEND_PORT || 3000)
);

/* ---------- Provide a DB handle for /healthz ---------- */
const dbHandle =
  DB?.pool /* pg.Pool */ ||
  DB?.knex /* knex instance */ ||
  DB?.db /* generic client/pool */ ||
  (DB?.query ? { query: DB.query } : null);
if (dbHandle) app.set("db", dbHandle);

/* ---------- CORS (configurable) ---------- */
const parseCSV = (s = "") =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const ALLOWED = parseCSV(process.env.ALLOWED_ORIGINS);

const COMMON_ALLOWED_HEADERS = [
  "Content-Type",
  "X-Workspace-Id",
  "X-Admin-Key",
  "X-Debug",
  "Authorization",
  "X-Request-Id",
];

const BASE_CORS = {
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: COMMON_ALLOWED_HEADERS,
  exposedHeaders: ["Content-Disposition", "X-Request-Id"],
  maxAge: 86400,
};

const corsOptions =
  isProd && ALLOWED.length > 0
    ? { origin: ALLOWED, ...BASE_CORS }
    : {
        origin: (origin, cb) => {
          if (!origin) return cb(null, true); // curl/postman/no Origin
          try {
            const { hostname } = new URL(origin);
            if (
              hostname === "localhost" ||
              hostname === "127.0.0.1" ||
              hostname === "::1"
            ) {
              return cb(null, true);
            }
          } catch {
            /* fall through */
          }
          if (ALLOWED.length === 0) return cb(null, true);
          return cb(null, ALLOWED.includes(origin));
        },
        ...BASE_CORS,
      };

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflights

/* ---------- Core middleware ---------- */
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

/* ---------- Request correlation & tiny logger ---------- */
app.use((req, res, next) => {
  const reqId = req.get("X-Request-Id") || randomUUID();
  req.requestId = reqId;
  res.setHeader("X-Request-Id", reqId);

  req.workspaceId = req.get("X-Workspace-Id") || "unknown";

  const start = process.hrtime.bigint();
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ` +
      `(ws=${req.workspaceId}, rid=${req.requestId})`
  );

  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    console.log(
      `↳ ${res.statusCode} ${req.method} ${req.originalUrl} ` +
        `in ${ms.toFixed(1)}ms (ws=${req.workspaceId}, rid=${req.requestId})`
    );
  });

  next();
});

/* ---------- Feature-flag kill switches (must be before routers) ---------- */
app.use(enforceKillSwitches);

/* ---------- Metrics: lazy-load & no-op fallback ---------- */
function makeNoopHistogram() {
  return {
    startTimer() {
      return () => {};
    },
    observe() {},
    labels() { return makeNoopHistogram(); },
  };
}
let histograms = {
  hPreview: makeNoopHistogram(),
  hPost: makeNoopHistogram(),
  hReco: makeNoopHistogram(),
  hImportPreview: makeNoopHistogram(),
  hImportCommit: makeNoopHistogram(),
};
let metricsHandler = (_req, res) => {
  res.status(501).type("text/plain").send("# metrics disabled\n");
};

try {
  // Try to import metrics module. It will itself attempt to load prom-client.
  const MetricsModule = await import("./utils/metrics.js");
  const M = MetricsModule.default ?? MetricsModule;
  if (M?.histograms) histograms = M.histograms;
  if (M?.metricsHandler) metricsHandler = M.metricsHandler;
} catch (e) {
  console.warn("Metrics disabled (utils/metrics.js not available):", e?.message || e);
}

/* ---------- Basic per-route metrics (preview/post/reco/import) ---------- */
function pickHistogram(req) {
  const u = (req.originalUrl || req.url || "").toLowerCase();

  // JE preview — support both new and legacy routes
  if (
    (u.startsWith("/api/orchestrateprompt") && req.method === "POST") ||
    u.startsWith("/api/orchestrate/preview")
  ) {
    return { hist: histograms.hPreview, route: "/orchestrate/preview" };
  }

  // JE post/confirm — support both new and legacy routes
  if (
    (u.startsWith("/api/confirmandsaveentry") && req.method === "POST") ||
    u.startsWith("/api/orchestrate/confirm") ||
    (u.startsWith("/api/ledger") && (req.method === "POST" || req.method === "PUT")) ||
    u.includes("/entries/confirm")
  ) {
    return { hist: histograms.hPost, route: "/orchestrate/post" };
  }

  // Bank reconciliation
  if (u.startsWith("/api/bankreco") || u.includes("/bankreco/")) {
    return { hist: histograms.hReco, route: "/bankreco" };
  }

  // Imports: preview vs commit
  if (/^\/api\/import\/.+\/preview/.test(u)) {
    return { hist: histograms.hImportPreview, route: "/import/preview" };
  }
  if (
    /^\/api\/import\/.+\/commit/.test(u) ||
    (u.startsWith("/api/import") && req.method === "POST")
  ) {
    return { hist: histograms.hImportCommit, route: "/import/commit" };
  }

  return null;
}

app.use((req, res, next) => {
  const picked = pickHistogram(req);
  if (!picked) return next();

  const end = picked.hist.startTimer({
    route: picked.route,
    workspace: req.workspaceId || "unknown",
  });
  const done = () => {
    try { end(); } catch { /* ignore */ }
  };
  res.on("finish", done);
  res.on("close", done);
  next();
});

/* ---------- Serve generated documents ---------- */
const FILES_DIR = path.join(__dirname, "generated_docs");
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}
app.use("/files", express.static(FILES_DIR));

/* ---------- Admin routes (before main API) ---------- */
app.use("/api/admin", adminRoutes);

/* ---------- Health / Ready / Healthz / Metrics ---------- */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    env: ENV,
    time: new Date().toISOString(),
    flags: getFlags(),
  });
});

app.get("/ready", async (_req, res) => {
  try {
    const r = await (DB?.query
      ? DB.query("SELECT 1 AS ok")
      : dbHandle?.query
      ? dbHandle.query("SELECT 1 AS ok")
      : Promise.resolve({ rows: [{ ok: 1 }] }));

    const ok = Array.isArray(r?.rows)
      ? r.rows[0]?.ok === 1 || r.rows[0]?.ok === "1"
      : true;
    res.json({ ok: !!ok });
  } catch (err) {
    console.error("Readiness check failed:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Deep health with DB round-trip & flags echo
app.get("/healthz", getHealthz);

// Prometheus metrics endpoint
app.get("/metrics", metricsHandler);

/* ---------- API routes ---------- */
app.use("/api", routes);

/* ---------- Root (optional) ---------- */
app.get("/", (_req, res) => {
  res.send("✅ Beyle Lekka Backend is live and ready.");
});

/* ---------- 404 (after routes) ---------- */
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok: false, error: "Not Found" });
});

/* ---------- Centralized error handler (last) ---------- */
app.use((err, _req, res, _next) => {
  console.error("✖ ERROR:", err);
  res.status(500).json({ ok: false, error: err?.message || "Internal Server Error" });
});

/* ---------- Startup tasks ---------- */
try {
  if (CoA.ensureBaseCoA) {
    await CoA.ensureBaseCoA();
    console.log("✓ Base Chart of Accounts ensured.");
  }
  if (CoA.canonicalizeExistingData) {
    await CoA.canonicalizeExistingData();
    console.log("✓ Existing ledger data canonicalized.");
  }
} catch (e) {
  console.error("Startup initialization failed:", e);
  // process.exit(1); // uncomment to fail hard on init problems
}

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export default app;
