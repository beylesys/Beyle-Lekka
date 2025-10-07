// controllers/importsController.js
import multer from "multer";
import fs from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { query, withTx } from "../services/db.js";
import { listProfiles, getProfile, autoDetect } from "../services/formats/registry.js";
import * as Hash from "../utils/hash.js";
import { ensureLedgerExists } from "../utils/coaService.js";

// --- file storage (disk; safe for big workbooks) ---
const UPLOAD_DIR = path.resolve("./uploads/imports");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")),
});
export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    // Simple MIME allow-list (xlsx, csv, json)
    const ok = /excel|spreadsheet|csv|text\/plain|json/.test(file.mimetype) || /\.(xlsx|csv|json)$/i.test(file.originalname);
    cb(ok ? null : new Error("unsupported_file_type"));
  },
});

// --- helpers ---
function requireTenant(req, res) {
  if (req.sessionId == null || typeof req.sessionId !== "string" || !req.sessionId.trim()) {
    res.status(400).json({ ok: false, error: "workspace_required", hint: "Send X-Workspace-Id header." });
    return null;
  }
  return String(req.sessionId);
}

function sha256File(p) {
  const h = createHash("sha256");
  const s = fs.createReadStream(p);
  return new Promise((resolve, reject) => {
    s.on("data", d => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function upsertFileRecord({ name, pathOnDisk, mime, size }) {
  const sha = await sha256File(pathOnDisk);
  // try existing
  const ex = await query(`SELECT id FROM files WHERE sha256 = $1`, [sha]);
  if (ex.rows?.length) {
    return { id: ex.rows[0].id, sha256: sha, reused: true };
  }
  const id = randomUUID();
  await query(
    `INSERT INTO files(id, sha256, name, mime, size_bytes, storage_path, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, datetime('now'))`,
    [id, sha, name, mime, size, pathOnDisk]
  );
  return { id, sha256: sha, reused: false };
}

async function getBatchOr404(id, res) {
  const r = await query(
    `SELECT b.*, f.name AS file_name, f.storage_path, f.mime AS file_mime, f.size_bytes
       FROM import_batches b
       JOIN files f ON f.id = b.file_id
      WHERE b.id = $1`, [id]);
  if (!r.rows?.length) {
    res.status(404).json({ ok: false, error: "batch_not_found" });
    return null;
  }
  return r.rows[0];
}

// --- controllers ---

export async function startImport(req, res) {
  try {
    const sid = requireTenant(req, res); if (!sid) return;

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "file_required" });

    const f = await upsertFileRecord({
      name: file.originalname,
      pathOnDisk: file.path,
      mime: file.mimetype,
      size: file.size,
    });

    // Read a small peek for sniff
    const peek = fs.readFileSync(file.path, { encoding: null });

    const detected = await autoDetect(peek.slice(0, 256 * 1024), file.originalname);
    const profileSuggestion = detected?.p?.id || null;

    const batchId = randomUUID();
    await query(
      `INSERT INTO import_batches(id, session_id, file_id, profile_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'UPLOADED', datetime('now'), datetime('now'))`,
      [batchId, sid, f.id, profileSuggestion]
    );

    res.status(201).json({
      ok: true,
      batchId,
      file: { id: f.id, name: file.originalname, size: file.size },
      suggestedProfileId: profileSuggestion,
      availableProfiles: listProfiles(),
    });
  } catch (err) {
    console.error("startImport failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "start_import_failed" });
  }
}

export async function getBatch(req, res) {
  try {
    const b = await getBatchOr404(String(req.params.id), res); if (!b) return;
    res.json({
      ok: true,
      batch: {
        id: b.id, session_id: b.session_id, file_id: b.file_id,
        profile_id: b.profile_id, status: b.status,
        counts: b.counts_json ? JSON.parse(b.counts_json) : null,
        errors: b.errors_json ? JSON.parse(b.errors_json) : null,
        file: { name: b.file_name, mime: b.file_mime, size_bytes: b.size_bytes },
      },
      availableProfiles: listProfiles(),
    });
  } catch (err) {
    console.error("getBatch failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "get_batch_failed" });
  }
}

export async function setProfile(req, res) {
  try {
    const b = await getBatchOr404(String(req.params.id), res); if (!b) return;
    const { profileId } = req.body || {};
    const p = getProfile(String(profileId || ""));
    if (!p) return res.status(400).json({ ok: false, error: "invalid_profile" });

    await query(`UPDATE import_batches SET profile_id=$1, updated_at = datetime('now') WHERE id=$2`, [p.id, b.id]);
    res.json({ ok: true, profile_id: p.id });
  } catch (err) {
    console.error("setProfile failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "set_profile_failed" });
  }
}

export async function previewImport(req, res) {
  try {
    const sid = requireTenant(req, res); if (!sid) return;
    const b = await getBatchOr404(String(req.params.id), res); if (!b) return;

    const profile = getProfile(b.profile_id);
    if (!profile) return res.status(400).json({ ok: false, error: "profile_not_set" });

    const buf = fs.readFileSync(b.storage_path);
    const parsed = await profile.parse(buf);

    // Begin staging: clear previous rows for this batch
    await query(`DELETE FROM import_rows WHERE batch_id = $1`, [b.id]);

    let idx = 0;
    const ins = async (etype, rec) => {
      await query(
        `INSERT INTO import_rows(id, batch_id, row_index, entity_type, raw_json, normalized_json, status)
         VALUES ($1,$2,$3,$4,$5,$6,'NORMALIZED')`,
        [randomUUID(), b.id, idx++, etype, null, JSON.stringify(rec)]
      );
    };

    const unknownAccounts = new Set();
    let pairCount = 0, lineCount = 0;

    if (Array.isArray(parsed?.pairs)) {
      for (const p of parsed.pairs) {
        pairCount++;
        await ins("pair", p);
        // collect accounts for suggestion report
        if (p.debit_account)  unknownAccounts.add(p.debit_account);
        if (p.credit_account) unknownAccounts.add(p.credit_account);
      }
    }
    if (Array.isArray(parsed?.lines)) {
      for (const l of parsed.lines) {
        lineCount++;
        await ins("journal_line", l);
        if (l.account) unknownAccounts.add(l.account);
      }
    }

    // Dup check (estimate): compute per-pair uniq hashes and ask DB how many exist already
    let dupPairs = 0;
    if (pairCount) {
      const seen = new Set();
      for (const p of parsed.pairs) {
        const hash = Hash.hashJournalPairs([{
          debit_account: p.debit_account, credit_account: p.credit_account,
          amount_cents: Math.round((Number(p.amount)||0) * 100),
          transaction_date: p.transaction_date, narration: p.narration || ""
        }]);
        if (!seen.has(hash)) {
          seen.add(hash);
          const r = await query(`SELECT 1 FROM ledger_entries WHERE session_id=$1 AND uniq_hash=$2 LIMIT 1`, [sid, hash]);
          if (r.rows?.length) dupPairs++;
        }
      }
    }

    const counts = { pairs: pairCount, journalLines: lineCount, estimatedDuplicates: dupPairs, uniqueAccounts: unknownAccounts.size };
    await query(`UPDATE import_batches SET status='PREVIEW', counts_json=$1, errors_json=$2, updated_at=datetime('now') WHERE id=$3`,
      [JSON.stringify(counts), JSON.stringify([]), b.id]);

    res.json({ ok: true, batchId: b.id, counts, unknownAccounts: Array.from(unknownAccounts).slice(0, 100) });
  } catch (err) {
    console.error("previewImport failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "preview_failed" });
  }
}

export async function commitImport(req, res) {
  try {
    const sid = requireTenant(req, res); if (!sid) return;
    const b = await getBatchOr404(String(req.params.id), res); if (!b) return;
    const profile = getProfile(b.profile_id);
    if (!profile) return res.status(400).json({ ok: false, error: "profile_not_set" });

    const buf = fs.readFileSync(b.storage_path);
    const parsed = await profile.parse(buf);

    // Build pairs (if only lines were provided, the parser already paired best-effort)
    const pairs = Array.isArray(parsed?.pairs) ? parsed.pairs : [];

    let inserted = 0, skipped = 0, errors = 0;

    await withTx(async exec => {
      for (const p of pairs) {
        try {
          const debit  = String(p.debit_account || "").trim();
          const credit = String(p.credit_account || "").trim();
          const amount = Number(p.amount || 0);
          const date   = String(p.transaction_date || p.date || "").slice(0, 10);
          const narr   = String(p.narration || "");

          if (!debit || !credit || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }

          // Ensure ledgers exist (tenant-aware)
          await ensureLedgerExists(debit, sid);
          await ensureLedgerExists(credit, sid);

          const amount_cents = Math.round(amount * 100);
          const uniq_hash = Hash.hashJournalPairs([{ debit_account: debit, credit_account: credit, amount_cents, transaction_date: date, narration: narr }]);

          // Skip if duplicate
          const ex = await exec(`SELECT 1 FROM ledger_entries WHERE session_id=$1 AND uniq_hash=$2 LIMIT 1`, [sid, uniq_hash]);
          if (ex.rows?.length) { skipped++; continue; }

          await exec(
            `INSERT INTO ledger_entries (id, session_id, debit_account, credit_account, amount_cents, narration, transaction_date, created_at, uniq_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7, datetime('now'), $8)`,
            [randomUUID(), sid, debit, credit, amount_cents, narr, date, uniq_hash]
          );
          inserted++;
        } catch (e) {
          errors++;
          // continue with next row
        }
      }
    });

    await query(`UPDATE import_batches SET status='COMMITTED', updated_at=datetime('now') WHERE id=$1`, [b.id]);
    res.json({ ok: true, batchId: b.id, result: { inserted, skipped, errors } });
  } catch (err) {
    console.error("commitImport failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "commit_failed" });
  }
}

export async function downloadTemplate(req, res) {
  try {
    const profile = getProfile(String(req.params.profile));
    if (!profile?.template) return res.status(404).json({ ok: false, error: "template_not_available" });
    const buf = profile.template();
    const ext = profile.kind === "xlsx" ? "xlsx" : (profile.kind === "csv" ? "csv" : "json");
    res.setHeader("Content-Disposition", `attachment; filename="${profile.id}.` + ext + `"`);
    res.setHeader("Content-Type", profile.kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
                               profile.kind === "csv" ? "text/csv" : "application/json");
    res.status(200).send(buf);
  } catch (err) {
    console.error("downloadTemplate failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "template_failed" });
  }
}
