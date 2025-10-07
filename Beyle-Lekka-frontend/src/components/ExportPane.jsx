// src/components/ExportPane.jsx
import React, { useState } from "react";
import { Box, Paper, Stack, Typography, Button, Alert, TextField, Select, MenuItem, FormControl, InputLabel, LinearProgress } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { exportDownload } from "../services/apiService";

const PROFILES = [
  { id: "xlsx-universal-workbook-v1", name: "Universal Workbook (.xlsx)" },
  { id: "csv-universal-journal-v1",  name: "Universal Journal (CSV)" },
  { id: "json-audit-package-v1",    name: "Audit Package (JSON)" },
];

export default function ExportPane() {
  const [profile, setProfile] = useState(PROFILES[0].id);
  const today = new Date().toISOString().slice(0, 10);
  const fyStart = new Date(new Date().getFullYear(), 3, 1).toISOString().slice(0, 10); // Apr 1 (India FY)
  const [from, setFrom] = useState(fyStart);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const onDownload = async () => {
    setBusy(true); setMsg(null);
    try {
      const ok = await exportDownload(profile, from, to);
      if (!ok) setMsg({ type: "warning", text: "Nothing to export for the selected period." });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Export your books</Typography>
        {msg && <Alert severity={msg.type}>{msg.text}</Alert>}
        {busy && <LinearProgress />}

        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 260 }}>
            <InputLabel id="exp-prof">Format</InputLabel>
            <Select labelId="exp-prof" label="Format" value={profile} onChange={(e) => setProfile(e.target.value)}>
              {PROFILES.map(p => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
            </Select>
          </FormControl>

          <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />

          <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload}>Download</Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
