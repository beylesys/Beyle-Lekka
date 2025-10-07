// controllers/exportsController.js
import archiver from "archiver";
import { getProfile, listProfiles } from "../services/formats/registry.js";
import * as DB from "../services/db.js";

function requireTenant(req, res) {
  if (req.sessionId == null || typeof req.sessionId !== "string" || !req.sessionId.trim()) {
    res.status(400).json({ ok: false, error: "workspace_required", hint: "Send X-Workspace-Id header." });
    return null;
  }
  return String(req.sessionId);
}

export async function exportData(req, res) {
  try {
    const sid = requireTenant(req, res); if (!sid) return;

    const profileId = String(req.query.profile || "");
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to || "").slice(0, 10);

    const p = getProfile(profileId);
    if (!p?.export) {
      return res.status(400).json({ ok: false, error: "invalid_or_unsupported_profile", profiles: listProfiles() });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ ok: false, error: "from_to_required", hint: "Use ?from=YYYY-MM-DD&to=YYYY-MM-DD" });
    }

    const { files } = await p.export(DB, sid, { from, to });
    if (!files?.length) return res.status(204).send();

    if (files.length === 1) {
      // Single file — stream directly
      const f = files[0];
      const name = String(f.name || "export.bin");
      const isXlsx = /\.xlsx$/i.test(name);
      const isCsv  = /\.csv$/i.test(name);
      const isJson = /\.json$/i.test(name);
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Content-Type", isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
                              isCsv ? "text/csv" : isJson ? "application/json" : "application/octet-stream");
      return res.status(200).send(typeof f.content === "string" ? f.content : Buffer.from(f.content));
    }

    // Multiple files — zip
    res.setHeader("Content-Disposition", `attachment; filename="${profileId}-${from}_to_${to}.zip"`);
    res.setHeader("Content-Type", "application/zip");
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);
    for (const f of files) {
      const name = String(f.name || "file.bin");
      archive.append(typeof f.content === "string" ? f.content : Buffer.from(f.content), { name });
    }
    await archive.finalize();
  } catch (err) {
    console.error("exportData failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "export_failed" });
  }
}
