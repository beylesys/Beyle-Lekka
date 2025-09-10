import React, { useEffect, useState, useMemo } from "react";
import {
  Box, Tabs, Tab, Stack, Typography, Switch, FormControl, InputLabel, Select, MenuItem,
  Table, TableHead, TableRow, TableCell, TableBody, Paper, TableContainer, Divider, IconButton, Tooltip
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { fetchLedgerView } from "../services/apiService";
import { computeTrialBalance, computePL, computeBalanceSheet, defaultAccountTypes } from "../utils/accounting";
import LedgerViewer from "./LedgerViewer";

const pretty = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function ReportsDrawer({ sessionId }) {
  const [tab, setTab] = useState(0);
  const [entries, setEntries] = useState([]);
  const [raw, setRaw] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchLedgerView(sessionId);
      setRaw(data);
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [sessionId]);

  // Memoize reports
  const tb = useMemo(() => computeTrialBalance(entries), [entries]);
  const pl = useMemo(() => computePL(entries, defaultAccountTypes), [entries]);
  const bs = useMemo(() => computeBalanceSheet(entries, defaultAccountTypes, pl), [entries, pl]);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile>
        <Tab label="Ledger" />
        <Tab label="Trial Balance" />
        <Tab label="Profit & Loss" />
        <Tab label="Balance Sheet" />
      </Tabs>

      <Divider />

      <Box sx={{ p: 2, display: tab === 0 ? "block" : "none" }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title="Refresh">
              <IconButton onClick={load}><RefreshIcon /></IconButton>
            </Tooltip>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2">Show raw response</Typography>
            <Switch checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          </Stack>
        </Stack>

        {/* Reuse your existing ledger viewer (account filter inside) */}
        <LedgerViewer sessionId={sessionId} />
        {showRaw && raw && (
          <>
            <Divider sx={{ my: 2 }} />
            <pre style={{ maxHeight: 240, overflow: "auto", background: "#fafafa", border: "1px solid #eee", padding: 12, fontSize: 12 }}>
              {JSON.stringify(raw, null, 2)}
            </pre>
          </>
        )}
      </Box>

      {/* Trial Balance */}
      <Box sx={{ p: 2, display: tab === 1 ? "block" : "none" }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>Trial Balance</Typography>
        <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>Debit</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>Credit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tb.map((r) => (
                <TableRow hover key={r.account}>
                  <TableCell>{r.account}</TableCell>
                  <TableCell align="right">₹{pretty(r.debit)}</TableCell>
                  <TableCell align="right">₹{pretty(r.credit)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Total</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  ₹{pretty(tb.reduce((s, r) => s + Number(r.debit || 0), 0))}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  ₹{pretty(tb.reduce((s, r) => s + Number(r.credit || 0), 0))}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Box>

      {/* P&L */}
      <Box sx={{ p: 2, display: tab === 2 ? "block" : "none" }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>Profit & Loss</Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <Box flex={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>Income</Typography>
            <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pl.income.map((r) => (
                    <TableRow hover key={r.account}>
                      <TableCell>{r.account}</TableCell>
                      <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Total Income</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>₹{pretty(pl.totalIncome)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Box>

          <Box flex={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>Expenses</Typography>
            <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pl.expenses.map((r) => (
                    <TableRow hover key={r.account}>
                      <TableCell>{r.account}</TableCell>
                      <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Total Expenses</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>₹{pretty(pl.totalExpenses)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Stack>

        <Box mt={2}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Net {pl.netProfit >= 0 ? "Profit" : "Loss"}: ₹{pretty(Math.abs(pl.netProfit))}
          </Typography>
        </Box>
      </Box>

      {/* Balance Sheet */}
      <Box sx={{ p: 2, display: tab === 3 ? "block" : "none" }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>Balance Sheet</Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <Box flex={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>Assets</Typography>
            <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {bs.assets.map((r) => (
                    <TableRow hover key={r.account}>
                      <TableCell>{r.account}</TableCell>
                      <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Total Assets</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>₹{pretty(bs.totals.assets)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Box>

          <Box flex={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>Liabilities & Equity</Typography>
            <TableContainer component={Paper} elevation={0} sx={{ border: "1px solid #eee" }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {bs.liabilities.map((r) => (
                    <TableRow hover key={`L-${r.account}`}>
                      <TableCell>{r.account}</TableCell>
                      <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                  {bs.equity.map((r) => (
                    <TableRow hover key={`E-${r.account}`}>
                      <TableCell>{r.account}</TableCell>
                      <TableCell align="right">₹{pretty(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Total Liabilities + Equity</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                      ₹{pretty(bs.totals.liabilitiesAndEquity)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Stack>
      </Box>
    </Box>
  );
}
