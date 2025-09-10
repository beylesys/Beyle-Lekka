import { useEffect, useMemo, useState } from "react";
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
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { fetchLedgerView } from "../services/apiService";

const prettyAmount = (n) =>
  typeof n === "number"
    ? n.toLocaleString("en-IN", { maximumFractionDigits: 2 })
    : `${n}`;

const normalize = (s) => (s || "").trim();

const LedgerViewer = ({ sessionId }) => {
  const [entries, setEntries] = useState([]);      // structured rows
  const [rawData, setRawData] = useState(null);    // backend raw payload
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState("__ALL__");
  const [showRaw, setShowRaw] = useState(false);

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
      // expects { ledgerView: "...", entries: [{transaction_date, debit_account, credit_account, amount, narration}, ...] }
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
                  {acc === "__ALL__" ? "All Accounts" : acc}
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
          <Switch
            checked={showRaw}
            onChange={(e) => setShowRaw(e.target.checked)}
            inputProps={{ "aria-label": "Show raw response" }}
          />
        </Stack>
      </Stack>

      {loading && <Typography color="primary">⏳ Loading ledger…</Typography>}
      {error && (
        <Typography color="error" sx={{ mb: 2 }}>
          {error}
        </Typography>
      )}

      {!loading && filtered.length === 0 && (
        <Typography color="text.secondary">No entries.</Typography>
      )}

      {filtered.length > 0 && (
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
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((r, i) => {
                const debitAcc = normalize(r.debit_account);
                const creditAcc = normalize(r.credit_account);

                // If filtering on one account, compute side + counterparty
                let side = "";
                let counterparty = "";
                if (selectedAccount === "__ALL__") {
                  side = debitAcc ? "Debit" : "Credit"; // fallback, but typically both present
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

                return (
                  <TableRow hover key={`${r.transaction_date}-${i}`}>
                    <TableCell>{r.transaction_date}</TableCell>
                    <TableCell>
                      {selectedAccount === "__ALL__" ? (
                        <Stack direction="row" spacing={1}>
                          <Chip size="small" label={`Dr: ${debitAcc || "-"}`} />
                          <Chip size="small" label={`Cr: ${creditAcc || "-"}`} />
                        </Stack>
                      ) : (
                        <Chip
                          size="small"
                          color={side === "Debit" ? "success" : "warning"}
                          label={side || "-"}
                        />
                      )}
                    </TableCell>
                    <TableCell>{selectedAccount === "__ALL__" ? "-" : counterparty}</TableCell>
                    <TableCell align="right">₹{prettyAmount(r.amount)}</TableCell>
                    <TableCell>{r.narration || "-"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {showRaw && rawData && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" gutterBottom>
            Raw backend response
          </Typography>
          <pre
            style={{
              maxHeight: 280,
              overflow: "auto",
              background: "#fafafa",
              border: "1px solid #eee",
              padding: 12,
              fontSize: 12,
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
