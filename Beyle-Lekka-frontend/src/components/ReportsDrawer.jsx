// src/components/ReportsDrawer.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Tabs,
  Tab,
  Stack,
  Typography,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Paper,
  TableContainer,
  IconButton,
  Tooltip,
  TextField,
  Chip,
  CircularProgress,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  fetchLedgerView, // kept for parity (not used here directly but left in case other parts depend on tree‑shaking)
  getTrialBalance,
  getPL,
  getBalanceSheet,
} from "../services/apiService";
import LedgerViewer from "./LedgerViewer";

const pretty = (n) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function ReportsDrawer({ sessionId = "default-session" }) {
  const [tab, setTab] = useState(0);

  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState("1900-01-01");
  const [to, setTo] = useState(today);

  // Server-backed report data
  const [tb, setTB] = useState([]);
  const [pl, setPL] = useState(null);
  const [bs, setBS] = useState(null);

  const [loadingReports, setLoadingReports] = useState(false);
  const [reportsError, setReportsError] = useState(null);

  // Force remount of LedgerViewer to trigger its internal reload
  const [ledgerReloadKey, setLedgerReloadKey] = useState(0);

  const refreshReports = async () => {
    setLoadingReports(true);
    setReportsError(null);
    try {
      const [tbRes, plRes, bsRes] = await Promise.all([
        getTrialBalance(asOf),
        getPL(from, to),
        getBalanceSheet(asOf),
      ]);

      setTB(Array.isArray(tbRes?.rows) ? tbRes.rows : Array.isArray(tbRes) ? tbRes : []);
      setPL(plRes && typeof plRes === "object" ? plRes : null);
      setBS(bsRes && typeof bsRes === "object" ? bsRes : null);
    } catch (e) {
      console.error("Failed to load reports:", e);
      setReportsError(e?.message || "Failed to load server reports");
      setTB([]);
      setPL(null);
      setBS(null);
    } finally {
      setLoadingReports(false);
    }
  };

  // Initial + whenever dates change
  useEffect(() => {
    refreshReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, from, to]);

  const tbTotals = useMemo(() => {
    return (tb || []).reduce(
      (acc, r) => {
        acc.debit += Number(r.debit || 0);
        acc.credit += Number(r.credit || 0);
        return acc;
      },
      { debit: 0, credit: 0 }
    );
  }, [tb]);

  const plIncome = Array.isArray(pl?.income) ? pl.income : [];
  const plExpenses = Array.isArray(pl?.expenses) ? pl.expenses : [];
  const plTotals = pl?.totals || { income: 0, expenses: 0, net: 0 };

  const bsAssets = Array.isArray(bs?.assets) ? bs.assets : [];
  const bsLE = Array.isArray(bs?.liab_equity) ? bs.liab_equity : [];
  const bsTotals = bs?.totals || { assets: 0, liab_equity: 0 };

  return (
    <Box>
      {/* Header: Tabs + Refresh */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable">
          <Tab label="Ledger" />
          <Tab label="Trial Balance" />
          <Tab label="Profit & Loss" />
          <Tab label="Balance Sheet" />
        </Tabs>
        <Tooltip title="Refresh all">
          <IconButton
            onClick={() => {
              setLedgerReloadKey((k) => k + 1); // force LedgerViewer to re-fetch
              refreshReports(); // re-fetch server-side reports
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        {loadingReports && <Chip size="small" label="Refreshing reports…" />}
        {reportsError && (
          <Chip size="small" color="error" label={reportsError} sx={{ ml: "auto" }} />
        )}
      </Box>

      {/* Filters */}
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="As of"
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          size="small"
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          size="small"
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
      </Stack>

      {/* Ledger (account-based with inline edit via LedgerViewer) */}
      <Box sx={{ display: tab === 0 ? "block" : "none" }}>
        {/* Remount on ledgerReloadKey change to pull latest data */}
        <LedgerViewer key={ledgerReloadKey} sessionId={sessionId} />
      </Box>

      {/* Trial Balance (SERVER ONLY) */}
      <Box sx={{ display: tab === 1 ? "block" : "none" }}>
        {loadingReports ? (
          <Box sx={{ p: 4, textAlign: "center" }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Account</TableCell>
                  <TableCell align="right">Debit</TableCell>
                  <TableCell align="right">Credit</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(tb || []).map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{r.account}</TableCell>
                    <TableCell align="right">₹{pretty(r.debit)}</TableCell>
                    <TableCell align="right">₹{pretty(r.credit)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Totals</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                    ₹{pretty(tbTotals.debit)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                    ₹{pretty(tbTotals.credit)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      {/* Profit & Loss (SERVER ONLY) */}
      <Box sx={{ p: 2, display: tab === 2 ? "block" : "none" }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
          Profit &amp; Loss
        </Typography>
        {loadingReports ? (
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={28} />
          </Box>
        ) : pl ? (
          <Stack direction={{ xs: "column", md: "row" }} spacing={4}>
            <Box flex={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Income
              </Typography>
              <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
                <Table size="small">
                  <TableBody>
                    {plIncome.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell>{r.account}</TableCell>
                        <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Total Income</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        ₹{pretty(plTotals.income || 0)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
            <Box flex={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Expenses
              </Typography>
              <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
                <Table size="small">
                  <TableBody>
                    {plExpenses.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell>{r.account}</TableCell>
                        <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Total Expenses</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        ₹{pretty(plTotals.expenses || 0)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Net Profit</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        ₹{pretty(plTotals.net || 0)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          </Stack>
        ) : (
          <Typography color="text.secondary">No data.</Typography>
        )}
      </Box>

      {/* Balance Sheet (SERVER ONLY) */}
      <Box sx={{ p: 2, display: tab === 3 ? "block" : "none" }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
          Balance Sheet
        </Typography>
        {loadingReports ? (
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={28} />
          </Box>
        ) : bs ? (
          <Stack direction={{ xs: "column", md: "row" }} spacing={4}>
            <Box flex={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Assets
              </Typography>
              <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
                <Table size="small">
                  <TableBody>
                    {bsAssets.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell>{r.account}</TableCell>
                        <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Total Assets</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        ₹{pretty(bsTotals.assets || 0)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
            <Box flex={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Liabilities &amp; Equity
              </Typography>
              <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
                <Table size="small">
                  <TableBody>
                    {bsLE.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell>{r.account}</TableCell>
                        <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Total Liab + Equity</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        ₹{pretty(bsTotals.liab_equity || 0)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          </Stack>
        ) : (
          <Typography color="text.secondary">No data.</Typography>
        )}
      </Box>
    </Box>
  );
}
