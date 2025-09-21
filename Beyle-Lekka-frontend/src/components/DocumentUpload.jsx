import React, { useState } from "react";
import {
  Box,
  Paper,
  Typography,
  Stack,
  Button,
  TextField,
  Divider,
  Alert,
  CircularProgress,
  Chip,
  FormControlLabel,
  Switch,
  Collapse
} from "@mui/material";
import {
  uploadDocument,
  orchestratePrompt,
  confirmFromPreview
} from "../services/apiService";

const prettyINR = (n) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Prefer classification.confidence, else safe fallbacks. */
function deriveConfidence(extraction) {
  const c1 = extraction?.classification?.confidence;
  if (typeof c1 === "number") return c1;
  const c2 = extraction?.meta?.doc_confidence;
  if (typeof c2 === "number") return c2;
  const c3 = extraction?.meta?.items_confidence;
  if (typeof c3 === "number") return c3;
  return null;
}

/** Extract amount & side robustly from a raw, single-sided line shape. */
function getRawAmountAndSide(line) {
  const nums = [];
  const maybes = [
    line?.amount,
    line?.debit,
    line?.credit,
    line?.dr,
    line?.cr,
    line?.DR,
    line?.CR,
    line?.debit_amount,
    line?.credit_amount
  ];
  for (const v of maybes) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  const amt = nums.length ? nums[0] : 0;

  const dr =
    (Number(line?.debit) > 0) ||
    (Number(line?.dr) > 0) ||
    (Number(line?.DR) > 0) ||
    /(^|\s)dr(\s|$)/i.test(String(line?.side || ""));

  const cr =
    (Number(line?.credit) > 0) ||
    (Number(line?.cr) > 0) ||
    (Number(line?.CR) > 0) ||
    /(^|\s)cr(\s|$)/i.test(String(line?.side || ""));

  const side = dr ? "DR" : (cr ? "CR" : "");
  return { amt, side };
}

/** Render a single raw DR/CR line (fallback shape). */
function RawLine({ line }) {
  const { amt, side } = getRawAmountAndSide(line);
  const date = line?.date || line?.transaction_date || "";
  const account =
    line?.account || line?.ledger || line?.debit_account || line?.credit_account || "";
  return <div>{`${date} | ${account} | ${side} ₹${prettyINR(amt)}`}</div>;
}

/** Render a single paired line (debit -> credit). */
function PairedLine({ row }) {
  const date = row?.date || row?.transaction_date || "";
  const debit = row?.debit || row?.debit_account || "";
  const credit = row?.credit || row?.credit_account || "";
  const amount = Number(row?.amount || 0);
  return <div>{`${date} | ${debit} -> ${credit} | ₹${prettyINR(amount)}`}</div>;
}

/** Approx preview balance (UI hint only; server remains source of truth). */
function computePreviewImbalance(preview) {
  // Prefer paired (these are inherently balanced).
  const paired =
    (preview?.ledgerView?.journal && Array.isArray(preview.ledgerView.journal) && preview.ledgerView.journal) ||
    (preview?.ledgerView?.lines   && Array.isArray(preview.ledgerView.lines)   && preview.ledgerView.lines) ||
    null;

  if (paired) return 0;

  const raw = Array.isArray(preview?.journal) ? preview.journal : [];
  if (!raw.length) return 0;

  let dr = 0, cr = 0;
  for (const l of raw) {
    const { amt, side } = getRawAmountAndSide(l);
    if (side === "DR") dr += amt;
    else if (side === "CR") cr += amt;
  }
  return Math.abs(dr - cr);
}

export default function DocumentUpload({ sessionId = "default-session" }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  // { docType, fields, fileId, extractionId, classification?, rawText? }
  const [extraction, setExtraction] = useState(null);
  const [fieldsJSON, setFieldsJSON] = useState("");

  // preview: { previewId, hash, ledgerView?, journal? }
  const [preview, setPreview] = useState(null);
  const [posted, setPosted] = useState(null);
  const [followup, setFollowup] = useState(null);

  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [force, setForce] = useState(false);

  // Developer debug opt-in
  const isDebug =
    (import.meta?.env?.VITE_SHOW_DEBUG === "1") ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1");
  const [debugInfo, setDebugInfo] = useState(null);

  const onSelect = (e) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const onUpload = async () => {
    if (!file) return;
    setMsg(null);
    setPreview(null);
    setPosted(null);
    setFollowup(null);
    setDebugInfo(null);
    setExtraction(null);

    try {
      setUploading(true);
      const res = await uploadDocument(file, { force });
      if (res?.ok) {
        const docType = res.docType || "none";
        const fields = res.fields || {};
        // Keep rawText hidden; we pass it to the orchestrator for intent only.
        setExtraction({ ...res, docType, fields });
        // Render ONLY structured fields. Never include raw text here.
        setFieldsJSON(JSON.stringify(fields, null, 2));
        setMsg({ type: "success", text: "Extraction complete. Review fields and preview." });
      } else {
        setMsg({ type: "error", text: res?.error || "Upload failed" });
      }
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setUploading(false);
    }
  };

  const toPreview = async () => {
    try {
      setMsg(null);
      setPreview(null);
      setPosted(null);
      setFollowup(null);
      setDebugInfo(null);

      let parsed;
      try {
        parsed = JSON.parse(fieldsJSON || "{}");
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      } catch {
        setMsg({
          type: "error",
          text: "Invalid JSON in 'Extracted fields'. Please fix and try again."
        });
        return;
      }

      const docType = extraction?.docType || "none";

      // STRUCTURED inbound flow
      const payload = {
        sessionId,
        docType,               // optional hint
        fields: parsed,        // extracted/edited fields “as is” (authoritative numbers/dates)
        source: "extraction",  // forces structured-doc path server-side
        meta: {
          // raw text ONLY for intent; backend will ignore its numbers
          rawText: extraction?.rawText || extraction?._raw_text || extraction?.snippet || ""
        },
        debug: isDebug
      };

      const res = await orchestratePrompt(payload);

      if (res && res.__debug) setDebugInfo(res.__debug);

      const looksLikePreview =
        res?.status === "preview" || (res?.previewId && res?.hash);

      const looksPosted =
        res?.status === "posted" ||
        res?.document ||
        (res?.ledgerView && !res?.previewId);

      if (res?.error) {
        setMsg({ type: "error", text: res.error });
        return;
      }

      if (res?.status === "followup_needed" && res?.clarification) {
        setFollowup({ clarification: res.clarification, promptType: res.promptType || null });
        setMsg({
          type: "info",
          text: "More detail required. Answer the question below in the Prompt page, or adjust fields and preview again."
        });
        return;
      }

      if (looksLikePreview) {
        setPreview({
          previewId: res.previewId,
          hash: res.hash,
          ledgerView: res.ledgerView || res.preview?.ledgerView || null,
          journal: Array.isArray(res.journal)
            ? res.journal
            : (Array.isArray(res.preview?.journal) ? res.preview.journal : null)
        });
        setMsg({ type: "success", text: "Preview created. You can confirm & post." });
        return;
      }

      if (looksPosted) {
        setPosted(res);
        setMsg({
          type: "info",
          text: "Server posted directly (no preview step)."
        });
        return;
      }

      setMsg({
        type: "warning",
        text: "Response did not include a preview or post. Adjust fields and try again."
      });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    }
  };

  const onConfirm = async () => {
    if (!preview?.previewId || !preview?.hash) {
      setMsg({ type: "error", text: "Missing previewId/hash." });
      return;
    }
    try {
      setPosting(true);
      const res = await confirmFromPreview({
        previewId: preview.previewId,
        hash: preview.hash,
        sessionId
      });
      setPosted(res);
      setPreview(null);
      setMsg({
        type: "success",
        text: `Posted. ${((res?.document?.docType || "") + " " + (res?.document?.number || "")).trim()}`
      });
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setPosting(false);
    }
  };

  const confidence = deriveConfidence(extraction);
  const confidenceText =
    typeof confidence === "number" ? `confidence ${confidence.toFixed(2)}` : null;

  const imbalance = preview ? computePreviewImbalance(preview) : 0;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1, fontWeight: 700 }}>
        Document Upload & Extraction
      </Typography>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <Button variant="outlined" component="label" disabled={uploading}>
            Choose file
            <input hidden type="file" onChange={onSelect} />
          </Button>
          <Typography noWrap sx={{ mr: 1 }}>{file?.name || "No file selected"}</Typography>
          <Button onClick={onUpload} variant="contained" disabled={!file || uploading}>
            {uploading ? (
              <CircularProgress size={20} color="inherit" />
            ) : (
              "Upload & Extract"
            )}
          </Button>
          <FormControlLabel
            sx={{ ml: 1 }}
            control={<Switch checked={force} onChange={(_, v) => setForce(v)} />}
            label="Re‑extract (ignore duplicate)"
          />
        </Stack>

        {msg && (
          <Alert severity={msg.type} sx={{ mt: 2 }}>
            {msg.text}
          </Alert>
        )}

        {extraction && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label={(extraction.docType || "DOC").toUpperCase()} size="small" />
              {confidenceText && (
                <Chip label={confidenceText} size="small" variant="outlined" />
              )}
              <Typography variant="subtitle2" color="text.secondary">
                fileId: {extraction.fileId} • extractionId: {extraction.extractionId || ""}
              </Typography>
            </Stack>

            <Typography variant="subtitle2" sx={{ mt: 1 }}>
              Extracted fields (edit as needed):
            </Typography>
            <TextField
              multiline
              minRows={8}
              fullWidth
              value={fieldsJSON}
              onChange={(e) => setFieldsJSON(e.target.value)}
              sx={{ mt: 1, fontFamily: "monospace" }}
            />

            <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
              <Button onClick={toPreview} variant="contained">
                Preview in Orchestrator
              </Button>
            </Stack>
          </>
        )}

        {/* Follow-up question (sanitized) */}
        {followup && (
          <>
            <Divider sx={{ my: 2 }} />
            <Chip size="small" label="More Detail Needed" />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {followup.clarification}
            </Typography>
          </>
        )}

        {/* Preview case */}
        {preview && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Chip size="small" label="Preview Ready" />
              <Typography variant="body2" color="text.secondary">
                previewId: {preview.previewId} • hash: {preview.hash}
              </Typography>
              <Chip
                size="small"
                label={imbalance < 0.005 ? "Balanced ✓" : `Unbalanced Δ ₹${prettyINR(imbalance)}`}
                color={imbalance < 0.005 ? "default" : "error"}
                sx={{ ml: 1 }}
              />
            </Stack>

            {/* Robust preview renderer */}
            {(() => {
              const paired =
                (preview?.ledgerView?.journal && Array.isArray(preview.ledgerView.journal) && preview.ledgerView.journal) ||
                (preview?.ledgerView?.lines   && Array.isArray(preview.ledgerView.lines)   && preview.ledgerView.lines) ||
                null;

              if (paired) {
                return (
                  <Box
                    sx={{
                      fontFamily: "monospace",
                      p: 1,
                      bgcolor: "#fafafa",
                      border: "1px solid #eee",
                      borderRadius: 1
                    }}
                  >
                    {paired.map((row, i) => <PairedLine key={i} row={row} />)}
                  </Box>
                );
              }

              if (Array.isArray(preview?.journal) && preview.journal.length) {
                return (
                  <Box
                    sx={{
                      fontFamily: "monospace",
                      p: 1,
                      bgcolor: "#fafafa",
                      border: "1px solid #eee",
                      borderRadius: 1
                    }}
                  >
                    {preview.journal.map((l, i) => <RawLine key={i} line={l} />)}
                  </Box>
                );
              }

              return null;
            })()}

            <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
              <Button onClick={onConfirm} variant="contained" disabled={posting}>
                {posting ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  "Confirm & Post"
                )}
              </Button>
            </Stack>
          </>
        )}

        {/* Posted / Non-preview case */}
        {posted && (
          <>
            <Divider sx={{ my: 2 }} />
            <Chip size="small" label="Posted" />
            <Box
              sx={{
                mt: 1,
                fontFamily: "monospace",
                p: 1,
                bgcolor: "#fafafa",
                border: "1px solid #eee",
                borderRadius: 1
              }}
            >
              <pre style={{ margin: 0 }}>
                {JSON.stringify(
                  {
                    success: posted?.success,
                    status: posted?.status,
                    document: posted?.document || null,
                    posted: posted?.posted || null
                  },
                  null,
                  2
                )}
              </pre>
            </Box>
          </>
        )}

        {/* Developer Debug (opt-in only) */}
        <Collapse in={Boolean(isDebug && debugInfo)}>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2">Developer Debug</Typography>
          <TextField
            multiline
            minRows={8}
            fullWidth
            value={JSON.stringify(debugInfo || {}, null, 2)}
            sx={{ mt: 1, fontFamily: "monospace" }}
          />
        </Collapse>
      </Paper>
    </Box>
  );
}
