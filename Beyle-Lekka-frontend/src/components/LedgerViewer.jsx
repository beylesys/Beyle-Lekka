import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  Typography,
  Stack,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableContainer,
  Paper,
  Tooltip,
  IconButton,
  Divider,
  TextField,
  CircularProgress,
} from "@mui/material";
import Autocomplete from "@mui/material/Autocomplete";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditIcon from "@mui/icons-material/Edit";
import SaveIcon from "@mui/icons-material/Save";
import CloseIcon from "@mui/icons-material/Close";
import { fetchLedgerView, updateLedgerEntry } from "../services/apiService";

const prettyAmount = (n) =>
  typeof n === "number"
    ? n.toLocaleString("en-IN", { maximumFractionDigits: 2 })
    : `${n}`;

const normalize = (s) => (s || "").trim();

const LedgerViewer = ({ sessionId }) => {
  const [entries, setEntries] = useState([]);
  const [rawData, setRawData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState("__ALL__");
  const [showRaw, setShowRaw] = useState(false);

  // inline edit
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setError("No session ID provided.");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLedgerView(sessionId);
      // expects { ledgerView: "...", entries: [{id, transaction_date, debit_account, credit_account, amount, narration}] }
      setRawData(data);
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch (e) {
      setError(e?.message || "Failed to fetch ledger.");
    } finally {
      setLoading(false);
    }
  };

  // Build list of accounts (debit + credit) for filtering
  const accounts = useMemo(() => {
    const set = new Set();
    entries.forEach((r) => {
      if (normalize(r.debit_account)) set.add(normalize(r.debit_account));
      if (normalize(r.credit_account)) set.add(normalize(r.credit_account));
    });
    return ["__ALL__", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [entries]);

  // Filter by selected account. If __ALL__, show all.
  const filtered = useMemo(() => {
    if (selectedAccount === "__ALL__") return entries;
    return entries.filter(
      (r) =>
        normalize(r.debit_account) === selectedAccount ||
        normalize(r.credit_account) === selectedAccount
    );
  }, [entries, selectedAccount]);

  const beginEdit = (row) => {
    setEditingId(row.id);
    setDraft({
      id: row.id,
      transaction_date: row.transaction_date,
      debit_account: row.debit_account,
      credit_account: row.credit_account,
      amount: row.amount,
      narration: row.narration || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = async () => {
    if (!draft) return;

    const amt = Number.parseFloat(String(draft.amount).replace(/[^\d.-]/g, ""));
    if (!draft.transaction_date || !/^\d{4}-\d{2}-\d{2}$/.test(draft.transaction_date)) {
      alert("Please enter a valid date (YYYY-MM-DD).");
      return;
    }
    if (!draft.debit_account || !draft.credit_account) {
      alert("Please fill both debit and credit accounts.");
      return;
    }
    if (draft.debit_account.trim().toLowerCase() === draft.credit_account.trim().toLowerCase()) {
      alert("Debit and Credit cannot be the same account.");
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      alert("Please enter a valid positive amount.");
      return;
    }

    setSaving(true);
    try {
      await updateLedgerEntry({
        id: draft.id,
        transaction_date: draft.transaction_date,
        debit_account: draft.debit_account,
        credit_account: draft.credit_account,
        amount: amt,
        narration: draft.narration ?? "",
      });
      // Optimistically update UI without a full reload
      setEntries((prev) =>
        prev.map((r) => (r.id === draft.id ? { ...r, ...draft, amount: amt } : r))
      );
      cancelEdit();
    } catch (err) {
      alert(err?.message || "Failed to update ledger entry");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        alignItems={{ xs: "stretch", sm: "center" }}
        justifyContent="space-between"
        sx={{ mb: 2 }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel id="acc-label">Account</InputLabel>
            <Select
              labelId="acc-label"
              value={selectedAccount}
              label="Account"
              onChange={(e) => setSelectedAccount(e.target.value)}
            >
              {accounts.map((acc) => (
                <MenuItem key={acc} value={acc}>
                  {acc === "__ALL__" ? <em>All accounts</em> : acc}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Tooltip title="Refresh ledger">
            <IconButton onClick={load}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2">Show raw response</Typography>
          <Switch checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
        </Stack>
      </Stack>

      {error && (
        <Box sx={{ mb: 2 }}>
          <Chip color="error" label={error} />
        </Box>
      )}

      {loading ? (
        <Box sx={{ p: 4, textAlign: "center" }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Account Side</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Counterparty</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  Amount
                </TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>Narration</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 90 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((r, i) => {
                const debitAcc = normalize(r.debit_account);
                const creditAcc = normalize(r.credit_account);

                let side = "";
                let counterparty = "";
                if (selectedAccount === "__ALL__") {
                  // When showing all, show a neutral side chip
                  side = debitAcc ? "Debit" : "Credit";
                  counterparty = debitAcc ? creditAcc : debitAcc;
                } else {
                  if (debitAcc === selectedAccount) {
                    side = "Debit";
                    counterparty = creditAcc || "";
                  } else if (creditAcc === selectedAccount) {
                    side = "Credit";
                    counterparty = debitAcc || "";
                  }
                }

                const inEdit = editingId === r.id;

                return (
                  <React.Fragment key={r.id || `${r.transaction_date}-${i}`}>
                    <TableRow hover>
                      <TableCell>{r.transaction_date}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          color={side === "Debit" ? "success" : "warning"}
                          label={side || "-"}
                        />
                      </TableCell>
                      <TableCell>{selectedAccount === "__ALL__" ? (debitAcc ? creditAcc : debitAcc) : counterparty}</TableCell>
                      <TableCell align="right">₹{prettyAmount(r.amount)}</TableCell>
                      <TableCell>{r.narration || "-"}</TableCell>
                      <TableCell>
                        {inEdit ? (
                          <Stack direction="row" spacing={1}>
                            <IconButton size="small" onClick={saveEdit} disabled={saving}>
                              <SaveIcon fontSize="small" />
                            </IconButton>
                            <IconButton size="small" onClick={cancelEdit} disabled={saving}>
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        ) : (
                          <Tooltip title="Edit row">
                            <IconButton size="small" onClick={() => beginEdit(r)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>

                    {inEdit && (
                      <TableRow>
                        <TableCell colSpan={6} sx={{ background: "#fcfcfc", borderTop: "1px dashed #eee" }}>
                          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                            <TextField
                              label="Date"
                              size="small"
                              type="date"
                              value={draft?.transaction_date || ""}
                              onChange={(e) =>
                                setDraft((d) => ({ ...d, transaction_date: e.target.value }))
                              }
                              InputLabelProps={{ shrink: true }}
                              sx={{ minWidth: 160 }}
                            />
                            <Autocomplete
                              sx={{ minWidth: 240 }}
                              size="small"
                              options={accounts.filter((a) => a !== "__ALL__")}
                              value={draft?.debit_account || ""}
                              onChange={(_e, val) =>
                                setDraft((d) => ({ ...d, debit_account: val || "" }))
                              }
                              renderInput={(params) => <TextField {...params} label="Debit Account" />}
                              freeSolo
                            />
                            <Autocomplete
                              sx={{ minWidth: 240 }}
                              size="small"
                              options={accounts.filter((a) => a !== "__ALL__")}
                              value={draft?.credit_account || ""}
                              onChange={(_e, val) =>
                                setDraft((d) => ({ ...d, credit_account: val || "" }))
                              }
                              renderInput={(params) => <TextField {...params} label="Credit Account" />}
                              freeSolo
                            />
                            <TextField
                              label="Amount"
                              size="small"
                              type="number"
                              inputProps={{ step: "0.01" }}
                              value={draft?.amount ?? ""}
                              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                              sx={{ minWidth: 160 }}
                            />
                            <TextField
                              label="Narration"
                              size="small"
                              value={draft?.narration ?? ""}
                              onChange={(e) => setDraft((d) => ({ ...d, narration: e.target.value }))}
                              fullWidth
                            />
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {showRaw && rawData && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Raw server payload
          </Typography>
          <pre
            style={{
              background: "#fafafa",
              borderRadius: 6,
              border: "1px solid #eee",
              padding: 12,
              fontSize: 12,
              overflow: "auto",
            }}
          >
            {JSON.stringify(rawData, null, 2)}
          </pre>
        </>
      )}
    </Box>
  );
};

export default LedgerViewer;
