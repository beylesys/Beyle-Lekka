// src/components/UniversalPromptBar.jsx
import React, { useState } from "react";
import { Box, TextField, Button, CircularProgress } from "@mui/material";
import { orchestratePrompt } from "../services/apiService";
import { usePrompt } from "../context/PromptContext";

const UniversalPromptBar = () => {
  const [loading, setLoading] = useState(false);
  const { prompt, setPrompt, sessionId, updatePromptSession } = usePrompt();

  const callOrchestrate = async (p, sid) => {
    // Prefer object signature; fall back to (prompt, sessionId) if needed
    try {
      const data = await orchestratePrompt({ sessionId: sid, prompt: p });
      if (data && typeof data === "object") return data;
    } catch (e) {
      // swallow and try fallback signature
    }
    // Fallback: legacy signature (prompt, sessionId)
    return await orchestratePrompt(p, sid);
  };

  const handleSubmit = async () => {
    const trimmed = (prompt || "").trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const response = await callOrchestrate(trimmed, sessionId);
      console.log("🫙 Raw AI Response:", response);

      // IMPORTANT: pass the backend payload through unchanged
      // Attach the user's original prompt so the thread can display it
      updatePromptSession({ ...response, originalPrompt: trimmed });
    } catch (err) {
      console.error("❌ Failed to orchestrate prompt:", err);
      // Send a minimal error payload; PromptContext will show an error entry
      updatePromptSession({ success: false, status: "error", error: "Failed to contact backend." });
    } finally {
      setPrompt(""); // Clear input after submission
      setLoading(false);
    }
  };

  return (
    <Box display="flex" alignItems="center" gap={2}>
      <TextField
        label="Ask Beyle Lekka"
        fullWidth
        variant="outlined"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
      />
      <Button
        onClick={handleSubmit}
        variant="contained"
        disabled={loading}
        sx={{ minWidth: "100px" }}
      >
        {loading ? <CircularProgress size={24} color="inherit" /> : "Ask"}
      </Button>
    </Box>
  );
};

export default UniversalPromptBar;
