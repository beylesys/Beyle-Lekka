import React, { useState, useEffect } from "react";
import { PromptProvider } from "./context/PromptContext.jsx";
import UniversalPromptBar from "./components/UniversalPromptBar";
import PromptThreadPane from "./components/PromptThreadPane";
// swap LedgerViewer for the new Reports drawer
import ReportsDrawer from "./components/ReportsDrawer";

import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Button,
  Drawer,
  Divider,
} from "@mui/material";
import MenuBookIcon from "@mui/icons-material/MenuBook";

// 🔁 NEW: tiny helper that pings your backend via Vite proxy (/health → :3000)
import { ping } from "./services/ping";

function App() {
  const [reportsOpen, setReportsOpen] = useState(false);

  // 🔁 NEW: backend status banner
  const [status, setStatus] = useState("checking…");
  useEffect(() => {
    ping()
      .then((d) => setStatus(`OK: ${d.time || ""}`))
      .catch((e) => setStatus(`ERR: ${e.message}`));
  }, []);

  return (
    <PromptProvider>
      {/* Top app bar */}
      <AppBar position="sticky" elevation={0} color="default">
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
            Beyle-Lekka
          </Typography>

          <Button
            variant="contained"
            startIcon={<MenuBookIcon />}
            onClick={() => setReportsOpen(true)}
            sx={{ borderRadius: 2 }}
          >
            Reports
          </Button>
        </Toolbar>
      </AppBar>

      {/* 🔁 NEW: simple backend status line */}
      <Box
        sx={{
          p: 1,
          borderBottom: "1px solid #eee",
          fontFamily: "monospace",
          bgcolor: "#fafafa",
        }}
      >
        Backend: {status}
      </Box>

      {/* Main content column: ONLY prompt + results */}
      <Box
        display="flex"
        flexDirection="column"
        height="calc(100vh - 64px)"
        sx={{ overflow: "hidden" }}
      >
        {/* Thread fills available space */}
        <Box flex={1} minHeight={0} sx={{ overflow: "auto" }}>
          <PromptThreadPane />
        </Box>

        {/* Prompt bar fixed at the bottom */}
        <Box
          borderTop="1px solid #eee"
          p={2}
          position="sticky"
          bottom={0}
          bgcolor="white"
          zIndex={1}
        >
          <UniversalPromptBar />
        </Box>
      </Box>

      {/* Right drawer for Reports (Ledger / TB / P&L / BS) */}
      <Drawer
        anchor="right"
        open={reportsOpen}
        onClose={() => setReportsOpen(false)}
        PaperProps={{ sx: { width: { xs: "100%", sm: 700 } } }}
      >
        <Box
          p={2}
          display="flex"
          alignItems="center"
          justifyContent="space-between"
        >
          <Typography variant="h6" fontWeight={700}>
            Reports
          </Typography>
          <Button onClick={() => setReportsOpen(false)}>Close</Button>
        </Box>
        <Divider />
        <Box sx={{ p: 2, height: "100%", overflow: "auto" }}>
          <ReportsDrawer sessionId="default-session" />
        </Box>
      </Drawer>
    </PromptProvider>
  );
}

export default App;
