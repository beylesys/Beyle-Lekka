// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes/api.js";
import { query } from "./services/db.js"; // kept, even if unused in startup
import fs from "fs";
import path from "path";
import { ensureBaseCoA } from "./utils/coaService.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

/* ---------- Core middleware ---------- */
app.use(cors()); // tighten if needed via ALLOWED_ORIGINS env
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------- Tiny request logger ---------- */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------- Serve generated documents ---------- */
const FILES_DIR = path.resolve("./generated_docs");
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}
app.use("/files", express.static(FILES_DIR));

/* ---------- Health checks ---------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ---------- API routes ---------- */
app.use("/api", routes);

/* ---------- Root (optional) ---------- */
app.get("/", (_req, res) => {
  res.send("✅ Beyle Lekka Backend is live and ready.");
});

/* ---------- Centralized error handler ---------- */
app.use((err, _req, res, _next) => {
  console.error("✖ ERROR:", err);
  res.status(500).json({ ok: false, error: err?.message || "Internal Server Error" });
});

/* ---------- Ensure base Chart of Accounts ---------- */
await ensureBaseCoA();

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
