// scripts/migrate.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

// Resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migDir = path.join(__dirname, "..", "migrations");

// Open the same SQLite file used by services/db.js
const dbPath = path.resolve(process.cwd(), process.env.SQLITE_FILE || "./beylelekka.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const files = fs
  .readdirSync(migDir)
  .filter((f) => f.toLowerCase().endsWith(".sql"))
  .sort(); // 001_..., 002_...

console.log(`[DB] Using SQLite file: ${dbPath}`);
console.log(`[MIGRATE] Applying ${files.length} migration(s) from ${migDir}`);

for (const f of files) {
  const full = path.join(migDir, f);
  let sql = fs.readFileSync(full, "utf-8");

  // Normalize newlines / trim
  sql = sql.replace(/\r\n/g, "\n").trim();

  if (!sql) {
    console.log(`→ ${f} (empty) — skipped`);
    continue;
  }

  console.log(`→ ${f} (${sql.length} bytes)`);

  try {
    // IMPORTANT: execute the entire file as a single batch
    // This safely handles CREATE TRIGGER ... BEGIN ... END; and any multi-statement migrations.
    db.exec(sql);
  } catch (err) {
    console.error(`🛑 Migration failed in ${f}: ${err.message}`);
    console.error(
      `   Hint: Triggers and BEGIN…END blocks contain internal semicolons; splitting SQL by ';' breaks them.\n` +
      `   This runner uses db.exec() to apply the whole file atomically.`
    );
    process.exit(1);
  }
}

console.log("✅ All migrations applied.");
