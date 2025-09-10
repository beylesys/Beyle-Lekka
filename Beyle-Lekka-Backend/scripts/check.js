// scripts/check.js
import dotenv from "dotenv";
dotenv.config();

const { query } = await import("../services/db.js");

console.log("Checking tables in:", process.env.SQLITE_FILE || "./beylelekka.db");

const tables = await query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
console.log("Tables:", tables.rows);

const led = await query("SELECT sql FROM sqlite_master WHERE name='ledger_entries'");
console.log("\nledger_entries DDL:\n", led.rows?.[0]?.sql || "(not found)");

const mem = await query("SELECT sql FROM sqlite_master WHERE name='memory_log'");
console.log("\nmemory_log DDL:\n", mem.rows?.[0]?.sql || "(not found)");
