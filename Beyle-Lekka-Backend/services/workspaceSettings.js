// services/workspaceSettings.js
import { query } from "./db.js";

export async function getDefaultSpendingAccount(sessionId) {
  const { rows } = await query(
    `SELECT default_spending_account FROM workspace_settings WHERE session_id=$1 LIMIT 1`,
    [sessionId]
  );
  return rows?.[0]?.default_spending_account || "Bank";
}

export async function setDefaultSpendingAccount(sessionId, account) {
  await query(
    `INSERT INTO workspace_settings(session_id, default_spending_account, updated_at)
     VALUES ($1,$2, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET default_spending_account=excluded.default_spending_account, updated_at=datetime('now')`,
    [sessionId, account]
  );
}
