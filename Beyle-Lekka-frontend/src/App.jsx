// src/App.jsx
import React, { useState } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { Box, AppBar, Toolbar, Typography, Button } from "@mui/material";

import { PromptProvider } from "./context/PromptContext.jsx";
import UniversalPromptBar from "./components/UniversalPromptBar";
import PromptThreadPane from "./components/PromptThreadPane";
import ReportsDrawer from "./components/ReportsDrawer";
import DocumentUpload from "./components/DocumentUpload";
import BankReconciliation from "./components/BankReconciliation";

function Nav() {
  const { pathname } = useLocation();
  const tab = (p) => (pathname === p ? "contained" : "text");
  return (
    <AppBar position="static">
      <Toolbar>
        <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>Beyle Lekka</Typography>
        <Button color="inherit" component={Link} to="/" variant={tab("/")}>Prompt</Button>
        <Button color="inherit" component={Link} to="/reports" variant={tab("/reports")}>Reports</Button>
        <Button color="inherit" component={Link} to="/docs" variant={tab("/docs")}>Docs</Button>
        <Button color="inherit" component={Link} to="/bank-reco" variant={tab("/bank-reco")}>Bank Reco</Button>
      </Toolbar>
    </AppBar>
  );
}

function PromptPage() {
  return (
    <Box sx={{ p: 2 }}>
      <UniversalPromptBar />
      <PromptThreadPane />
    </Box>
  );
}

export default function App() {
  return (
    <PromptProvider>
      <BrowserRouter>
        <Nav />
        <Box sx={{ p: 2 }}>
          <Routes>
            <Route path="/" element={<PromptPage />} />
            <Route path="/reports" element={<ReportsDrawer sessionId="default-session" />} />
            <Route path="/docs" element={<DocumentUpload sessionId="default-session" />} />
            <Route path="/bank-reco" element={<BankReconciliation />} />
          </Routes>
        </Box>
      </BrowserRouter>
    </PromptProvider>
  );
}
