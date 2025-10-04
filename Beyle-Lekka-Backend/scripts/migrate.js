// scripts/migrate.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.SQLITE_DB_PATH || path.resolve(__dirname, "..", "beylelekka.db");
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const FROM = arg("--from");           // e.g. --from 011
const ONLY = arg("--only");           // e.g. --only 011_fix_guardrails.sql

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations(
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const checksum = (s) => crypto.createHash("sha256").update(s).digest("hex");

function hasColumn(table, col) {
  const row = db.prepare(`SELECT 1 AS x FROM pragma_table_info('${table}') WHERE name=?`).get(col);
  return !!row;
}

const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

console.log(`[DB] Using SQLite file: ${DB_PATH}`);
console.log(`[MIGRATE] Considering ${files.length} migration(s) from ${MIGRATIONS_DIR}`);

for (const file of files) {
  if (ONLY && file !== ONLY) continue;
  if (FROM && file.slice(0, 3) < FROM) continue;

  const id = file;
  const full = path.join(MIGRATIONS_DIR, file);
  const sql = fs.readFileSync(full, "utf8");
  const cs = checksum(sql);

  const existing = db.prepare("SELECT checksum FROM _migrations WHERE id=?").get(id);
  if (existing) {
    if (existing.checksum !== cs) {
      throw new Error(`Migration ${id} already applied with different checksum.`);
    }
    console.log(`→ ${id} (skipped, already applied)`);
    continue;
  }

  // Special case: 005 was a one‑time conversion from 'amount' → 'amount_cents'.
  if (file.startsWith("005_")) {
    const hasAmount = hasColumn("ledger_entries", "amount");
    const hasCents  = hasColumn("ledger_entries", "amount_cents");
    if (!hasAmount && hasCents) {
      console.log(`→ ${id} (skipped — DB already in cents)`);
      db.prepare("INSERT INTO _migrations(id, checksum) VALUES (?, ?)").run(id, cs);
      continue;
    }
  }

  try {
    db.exec(sql);
    db.prepare("INSERT INTO _migrations(id, checksum) VALUES (?, ?)").run(id, cs);
    console.log(`✓ ${id}`);
  } catch (e) {
    console.error(`✖ Migration failed in ${id}:`, e.message);
    console.error("Hint: Triggers inside SQL must be preceded by DROP TRIGGER IF EXISTS to be idempotent.");
    process.exit(1);
  }
}

console.log("All pending migrations applied.");
