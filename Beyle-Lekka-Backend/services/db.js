// services/db.js
import Database from "better-sqlite3";
import path from "path";

const resolvedPath = path.resolve(process.cwd(), process.env.SQLITE_FILE || "./beylelekka.db");
console.log(`[DB] Using SQLite file: ${resolvedPath}`);

const sqlite = new Database(resolvedPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Convert $1,$2,... -> ? so your existing SQL works
function adapt(sql, params = []) {
  let i = 0;
  const s = sql.replace(/\$(\d+)/g, () => {
    i++;
    return "?";
  });
  return { s, p: params };
}

export const query = (sql, params = []) => {
  const { s, p } = adapt(sql, params);
  const lowered = s.trim().toLowerCase();
  const stmt = sqlite.prepare(s);
  if (lowered.startsWith("select") || lowered.startsWith("with")) {
    return { rows: stmt.all(p) };
  }
  const info = stmt.run(p);
  return { rows: [], changes: info.changes, lastID: info.lastInsertRowid };
};
