// services/db.pg.impl.js
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL==="disable"?false:{rejectUnauthorized:false}, max:10 });

export async function query(sql, params=[]) {
  const c = await pool.connect();
  try {
    const r = await c.query(sql, params);
    return { rows: r.rows, lastInsertRowid: undefined, changes: r.rowCount };
  } finally { c.release(); }
}

export async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const res = await fn(async (s,p=[]) => c.query(s,p));
    await c.query("COMMIT");
    return res;
  } catch (e) { try{ await c.query("ROLLBACK"); }catch{}; throw e; }
  finally { c.release(); }
}

export function rawDb() { return null; }
