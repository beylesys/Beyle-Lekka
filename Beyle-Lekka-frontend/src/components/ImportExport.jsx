// src/components/ImportExport.jsx
import React, { useState } from "react";
import { Box, Tabs, Tab, Stack } from "@mui/material";
import ImportWizard from "./ImportWizard";
import ExportPane from "./ExportPane";

export default function ImportExport() {
  const [tab, setTab] = useState(0);
  return (
    <Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Import" />
        <Tab label="Export" />
      </Tabs>
      <Stack spacing={2}>
        {tab === 0 && <ImportWizard />}
        {tab === 1 && <ExportPane />}
      </Stack>
    </Box>
  );
}
