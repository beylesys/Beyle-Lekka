// src/components/BankReconciliation.jsx
import React, { useEffect, useState } from "react";
import {
  Box, Paper, Typography, Stack, Button, TextField, Divider, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton, CircularProgress
} from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import { importBankCSV, fetchRecoSuggestions, confirmRecoMatch } from "../services/apiService";

export default function BankReconciliation() {
  const [file, setFile] = useState(null);
  const [bankAccountId, setBankAccountId] = useState("");
  const [dateFrom, setDateFrom] = useState("1900-01-01");
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [suggestions, setSuggestions] = useState([]);

  const onSelect = (e) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const doImport = async () => {
    if (!file) return;
    setMsg(null);
    try {
      setBusy(true);
      const res = await importBankCSV(file);
      if (!res?.ok) throw new Error(res?.error || "Import failed");
      setMsg({ type: "success", text: `Imported ${res.imported} lines.` });
      await loadSuggestions();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const loadSuggestions = async () => {
    if (!bankAccountId) {
      setMsg({ type: "warning", text: "Provide bankAccountId to fetch suggestions." });
      return;
    }
    try {
      setBusy(true);
      const res = await fetchRecoSuggestions({ bankAccountId, dateFrom, dateTo });
      if (!res?.ok) throw new Error(res?.error || "Failed to load suggestions");
      setSuggestions(res.suggestions || []);
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const onMatch = async (bankLineId, ledgerEntryId) => {
    try {
      setBusy(true);
      const res = await confirmRecoMatch(bankLineId, ledgerEntryId);
      if (!res?.ok) throw new Error(res?.error || "Match failed");
      setMsg({ type: "success", text: "Matched." });
      await loadSuggestions();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { /* no-op */ }, []);

  // Try to render flexible structure
  const renderCandidates = (cands = [], bankLineId) => {
    if (!Array.isArray(cands) || !cands.length) return <em>No candidates</em>;
    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Date</TableCell>
            <TableCell>Debit</TableCell>
            <TableCell>Credit</TableCell>
            <TableCell align="right">Amount</TableCell>
            <TableCell>Score</TableCell>
            <TableCell align="center">Action</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {cands.map((c, i) => (
            <TableRow key={i}>
              <TableCell>{c.transaction_date || c.date}</TableCell>
              <TableCell>{c.debit_account || c.debit}</TableCell>
              <TableCell>{c.credit_account || c.credit}</TableCell>
              <TableCell align="right">{Number(c.amount_cents || c.amount || 0) / 100}</TableCell>
              <TableCell>{(c.score ?? "").toString()}</TableCell>
              <TableCell align="center">
                <IconButton onClick={() => onMatch(bankLineId, c.id)} title="Match" size="small">
                  <LinkIcon fontSize="small" />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>Bank Reconciliation</Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center">
          <TextField
            label="Bank Account ID"
            size="small"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          />
          <TextField
            label="From"
            type="date"
            size="small"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="To"
            type="date"
            size="small"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <Button variant="outlined" component="label" disabled={busy}>
            Choose CSV
            <input hidden type="file" accept=".csv,text/csv" onChange={onSelect} />
          </Button>
          <Button onClick={doImport} variant="contained" disabled={!file || busy}>
            {busy ? <CircularProgress size={20} color="inherit" /> : "Import"}
          </Button>
          <Button onClick={loadSuggestions} variant="text" disabled={busy || !bankAccountId}>
            Refresh Suggestions
          </Button>
        </Stack>
        {msg && <Alert severity={msg.type} sx={{ mt: 2 }}>{msg.text}</Alert>}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 700 }}>Suggestions</Typography>
        {!suggestions.length ? (
          <Typography color="text.secondary">No suggestions yet.</Typography>
        ) : (
          suggestions.map((sugg, idx) => {
            const b = sugg.bankLine || sugg.bank_line || {};
            return (
              <Box key={idx} sx={{ mb: 2, p: 1, border: "1px solid #eee", borderRadius: 1 }}>
                <Typography variant="subtitle2">
                  Bank line: {b.value_date || b.date} • {b.description || b.narration} • ₹{Number(b.amount_cents || b.amount || 0) / 100}
                </Typography>
                <Divider sx={{ my: 1 }} />
                {renderCandidates(sugg.candidates || sugg.matches || [], b.id)}
              </Box>
            );
          })
        )}
      </Paper>
    </Box>
  );
}
