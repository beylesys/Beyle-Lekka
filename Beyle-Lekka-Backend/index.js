// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes/api.js";
import { query } from "./services/db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as CoA from "./utils/coaService.js"; // single consolidated import
import adminRoutes from "./routes/admin.js";

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

/* ---------- CORS (configurable) ---------- */
const parseCSV = (s = "") =>
  s.split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const ALLOWED = parseCSV(process.env.ALLOWED_ORIGINS);

// headers we actually use across the app
const COMMON_ALLOWED_HEADERS = [
  "Content-Type",
  "X-Workspace-Id",
  "X-Admin-Key",
  "X-Debug",
  "Authorization",
];

const BASE_CORS = {
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: COMMON_ALLOWED_HEADERS,
  exposedHeaders: ["Content-Disposition"],
  maxAge: 86400, // cache preflight for 1 day
};

/**
 * - Production: if ALLOWED_ORIGINS set, use allowlist strictly.
 * - Dev: allow any localhost/127.0.0.1/::1 to avoid being bricked by port bumps.
 *        If ALLOWED_ORIGINS also provided, those will be allowed too.
 */
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
// handle all preflight requests
app.options("*", cors(corsOptions));

/* ---------- Core middleware ---------- */
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

/* ---------- Tiny request logger ---------- */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
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

/* ---------- Health & readiness ---------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, env: ENV, time: new Date().toISOString() });
});

app.get("/ready", async (_req, res) => {
  try {
    const r = await query("SELECT 1 AS ok");
    const ok = Array.isArray(r?.rows)
      ? r.rows[0]?.ok === 1 || r.rows[0]?.ok === "1"
      : true;
    res.json({ ok: !!ok });
  } catch (err) {
    console.error("Readiness check failed:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

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
  // If you want to fail hard on init problems, uncomment the next line:
  // process.exit(1);
}

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

export default app;
