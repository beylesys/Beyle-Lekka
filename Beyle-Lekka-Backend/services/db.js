// services/db.js  — adapter (SQLite now, PG later without touching controllers)
const DB = (process.env.DB || "sqlite").toLowerCase();

let impl;
if (DB === "postgres") {
  impl = await import("./db.pg.impl.js");
} else {
  impl = await import("./db.sqlite.impl.js"); // <-- this is your EXISTING code, just renamed
}

export const query = impl.query;
export const withTx = impl.withTx;
export const rawDb = impl.rawDb ?? (() => null);
