// src/components/ImportWizard.jsx
import React, { useMemo, useState } from "react";
import {
  Box, Paper, Stack, Typography, Button, Alert, Divider,
  Select, MenuItem, FormControl, InputLabel, Chip, LinearProgress
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import PreviewIcon from "@mui/icons-material/Preview";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import DownloadIcon from "@mui/icons-material/Download";

import {
  importUpload, importGetBatch, importSetProfile,
  importPreview, importCommit, downloadTemplate
} from "../services/apiService";

const PROFILES = [
  { id: "xlsx-universal-workbook-v1", name: "Universal Workbook (.xlsx)" },
  { id: "csv-universal-journal-v1",  name: "Universal Journal (CSV)" },
  { id: "csv-bank-statement-v1",    name: "Bank Statement (CSV)" },
  { id: "json-audit-package-v1",    name: "Audit Package (JSON)" },
];

export default function ImportWizard() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const [batchId, setBatchId] = useState(null);
  const [profiles, setProfiles] = useState(PROFILES); // fallback to generic list
  const [selectedProfile, setSelectedProfile] = useState("");

  const [counts, setCounts] = useState(null);
  const [unknownAccounts, setUnknownAccounts] = useState([]);

  const [step, setStep] = useState(1); // 1 upload, 2 profile/preview, 3 commit, 4 done

  const profileName = useMemo(() => {
    const p = profiles.find((x) => x.id === selectedProfile);
    return p ? p.name : "";
  }, [profiles, selectedProfile]);

  const onChooseFile = (e) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    setMsg(null);
  };

  const onUpload = async () => {
    if (!file) return setMsg({ type: "warning", text: "Please choose a file to upload." });
    setBusy(true); setMsg(null);
    try {
      const res = await importUpload(file);
      if (!res?.ok) throw new Error(res?.error || "Upload failed");
      setBatchId(res.batchId);
      setProfiles(res.availableProfiles?.length ? res.availableProfiles : PROFILES);
      setSelectedProfile(res.suggestedProfileId || res.availableProfiles?.[0]?.id || PROFILES[0].id);
      setStep(2);
      setMsg({ type: "success", text: "File uploaded. A profile has been detected—you can confirm or change it." });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onConfirmProfile = async () => {
    if (!batchId || !selectedProfile) return;
    setBusy(true); setMsg(null);
    try {
      const res = await importSetProfile(batchId, selectedProfile);
      if (!res?.ok) throw new Error(res?.error || "Could not set profile");
      setMsg({ type: "success", text: `Profile set: ${selectedProfile}` });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async () => {
    if (!batchId) return;
    setBusy(true); setMsg(null);
    try {
      const res = await importPreview(batchId);
      if (!res?.ok) throw new Error(res?.error || "Preview failed");
      setCounts(res.counts || null);
      setUnknownAccounts(res.unknownAccounts || []);
      setStep(3);
      setMsg({ type: "info", text: "Preview ready. Review counts and then commit to post entries." });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    if (!batchId) return;
    setBusy(true); setMsg(null);
    try {
      const res = await importCommit(batchId);
      if (!res?.ok) throw new Error(res?.error || "Commit failed");
      setMsg({ type: "success", text: `Committed: ${res.result?.inserted || 0} inserted, ${res.result?.skipped || 0} skipped, ${res.result?.errors || 0} errors.` });
      setStep(4);
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const downloadTpl = async (id) => {
    try { await downloadTemplate(id); }
    catch (e) { setMsg({ type: "error", text: e.message }); }
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Import data</Typography>

        {msg && <Alert severity={msg.type}>{msg.text}</Alert>}
        {busy && <LinearProgress />}

        {/* Step 1: upload */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>1) Upload a file (XLSX/CSV/JSON)</Typography>
          <Stack direction="row" spacing={2} alignItems="center">
            <input type="file" onChange={onChooseFile} />
            <Button variant="contained" startIcon={<CloudUploadIcon />} onClick={onUpload} disabled={!file || busy}>
              Upload
            </Button>
          </Stack>
        </Box>

        {/* Templates */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>Optional: Download a blank template</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            {PROFILES.map(p => (
              <Button key={p.id} size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={() => downloadTpl(p.id)}>
                {p.name}
              </Button>
            ))}
          </Stack>
        </Box>

        <Divider />

        {/* Step 2: choose/confirm profile */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>2) Confirm format</Typography>
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" sx={{ minWidth: 280 }}>
              <InputLabel id="profile-label">Format</InputLabel>
              <Select
                labelId="profile-label"
                value={selectedProfile}
                label="Format"
                onChange={(e) => setSelectedProfile(e.target.value)}
                disabled={!batchId || busy}
              >
                {(profiles || []).map(p => (
                  <MenuItem key={p.id} value={p.id}>{p.displayName || p.name || p.id}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button variant="outlined" onClick={onConfirmProfile} disabled={!batchId || busy}>Confirm</Button>
            <Button variant="contained" startIcon={<PreviewIcon />} onClick={onPreview} disabled={!batchId || busy}>
              Preview
            </Button>
          </Stack>
          {batchId && (
            <Typography variant="caption" sx={{ mt: 1, display: "block" }}>
              Batch: <strong>{batchId}</strong> &nbsp;|&nbsp; Profile: <strong>{profileName || selectedProfile}</strong>
            </Typography>
          )}
        </Box>

        {/* Step 3: preview summary */}
        {counts && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>3) Preview summary</Typography>
            <Stack direction="row" spacing={2}>
              <Chip label={`Pairs: ${counts.pairs || 0}`} />
              <Chip label={`Lines: ${counts.journalLines || 0}`} />
              <Chip color={(counts.estimatedDuplicates || 0) > 0 ? "warning" : "default"}
                    label={`Estimated duplicates: ${counts.estimatedDuplicates || 0}`} />
              <Chip label={`Unique accounts in file: ${counts.uniqueAccounts || 0}`} />
            </Stack>

            {unknownAccounts?.length > 0 && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Unknown / new ledgers detected (sample):
                <Box sx={{ mt: 1, display: "flex", gap: 1, flexWrap: "wrap" }}>
                  {unknownAccounts.slice(0, 50).map((a) => <Chip key={a} label={a} size="small" />)}
                </Box>
              </Alert>
            )}

            <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
              <Button variant="contained" color="success" startIcon={<DoneAllIcon />} onClick={onCommit} disabled={busy}>
                Commit & Post
              </Button>
            </Stack>
          </Box>
        )}

        {/* Step 4: done */}
        {step === 4 && (
          <Alert severity="success">Import completed. You can now view reports or export your books.</Alert>
        )}
      </Stack>
    </Paper>
  );
}
