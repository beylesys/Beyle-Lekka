// services/memory.js (SQLite-ready, matches migration with `result` column)
import { query } from "./db.js";

const safeParse = (v) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

// âœ… Store new memory record
async function store(
  sessionId,
  {
    userId = "guest",
    prompt,
    result,                 // object/string from caller
    type = "unknown",
    status = "pending",
    source = "prompt",
  }
) {
  try {
    console.log("ðŸ§  Attempting to store memory with values:", {
      sessionId, userId, prompt, result, type, status, source
    });

    await query(
      `INSERT INTO memory_log
         (session_id, user_id, prompt, result, type, status, source, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, datetime('now'))`,
      [
        sessionId,
        userId,
        prompt,
        JSON.stringify(result ?? null), // <-- TEXT in SQLite
        type,
        status,
        source,
      ]
    );

    console.log("âœ… Memory stored successfully for session:", sessionId);
  } catch (err) {
    console.error("âŒ FULL MEMORY LOG ERROR:", err);
  }
}

// ðŸ” Update memory status (e.g., after confirmation)
async function updateStatus(sessionId, newStatus = "confirmed") {
  try {
    await query(
      `UPDATE memory_log
         SET status = $1
       WHERE session_id = $2`,
      [newStatus, sessionId]
    );
    console.log(`ðŸ§  Memory status updated â†’ ${newStatus} for session ${sessionId}`);
  } catch (err) {
    console.error("âŒ Error updating memory status:", err);
  }
}

// ðŸ“¥ Get memory by session (optional utility)
async function getBySession(sessionId) {
  try {
    const { rows } = await query(
      `SELECT * FROM memory_log WHERE session_id = $1`,
      [sessionId]
    );
    const row = rows[0] || null;
    if (row) row.result = safeParse(row.result); // <-- parse TEXT -> JSON
    return row;
  } catch (err) {
    console.error("âŒ Error fetching memory by session:", err);
    return null;
  }
}

export { store as logToMemory, updateStatus, getBySession };
