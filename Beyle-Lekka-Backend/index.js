// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes/api.js";
import { query } from "./services/db.js";
import fs from "fs";                    // ← add
import path from "path";                // ← add

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

/* ---------- Core middleware ---------- */
app.use(cors()); // (optional) tighten with origin: process.env.ALLOWED_ORIGINS?.split(","))
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------- Tiny request logger ---------- */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------- Serve generated documents ---------- */
const FILES_DIR = path.resolve("./generated_docs");            // ← add
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, {       // ← add
  recursive: true
});
app.use("/files", express.static(FILES_DIR));                  // ← add

/* ---------- Health checks ---------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// SQLite-safe DB probe
app.get("/db/health", async (_req, res, next) => {
  try {
    const r = await query("select datetime('now') as now");
    res.json({ ok: true, dbTime: r.rows?.[0]?.now || null });
  } catch (err) {
    next(err);
  }
});

/* ---------- API routes ---------- */
app.use("/api", routes);

/* ---------- Root (optional) ---------- */
app.get("/", (_req, res) => {
  res.send("✅ Beyle Lekka Backend is live and ready.");
});

/* ---------- Centralized error handler ---------- */
app.use((err, _req, res, _next) => {
  console.error("❌ ERROR:", err);
  res.status(500).json({ ok: false, error: err?.message || "Internal Server Error" });
});

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
