// src/components/PromptThreadPane.jsx
import React, { useEffect, useRef, useState } from "react";
import {
  Box, Typography, Card, CardContent, Divider, Button, Alert, Chip, TextField, IconButton
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import CloseIcon from "@mui/icons-material/Close";
import { usePrompt } from "../context/PromptContext";
import { confirmEntry, orchestratePrompt as orchestrateAPI } from "../services/apiService";
import { BASE_URL } from "../services/apiService";

const filesBase = (BASE_URL || "").replace(/\/api\/?$/, "");

const pickDocFields = (docType, documentFields) => {
  if (!docType || docType === "none" || !documentFields) return null;
  if (documentFields[docType]) return documentFields[docType];
  if (docType === "payment_voucher") {
    if (documentFields.payment_voucher) return documentFields.payment_voucher;
    if (documentFields.voucher) return documentFields.voucher;
  }
  return null;
};

const DocumentPreview = ({ docType, documentFields }) => {
  if (!docType || docType === "none") return null;
  const f = pickDocFields(docType, documentFields);
  if (!f) return null;

  if (docType === "invoice") {
    const items = Array.isArray(f.items) ? f.items : [];
    const subtotal = items.reduce((s, it) => {
      const qty = Number(it && it.qty != null ? it.qty : 0);
      const rate = Number(it && it.rate != null ? it.rate : 0);
      const hasAmount = !!(it && it.amount != null);
      const line = hasAmount ? Number(it.amount) : qty * rate;
      return s + (Number.isFinite(line) ? line : 0);
    }, 0);
    const taxes = Number(f && f.taxes != null ? f.taxes : 0);
    const total = (f && f.totalAmount != null && Number.isFinite(Number(f.totalAmount)))
      ? Number(f.totalAmount)
      : subtotal + taxes;

    return (
      <Box sx={{ border: "1px dashed #ccc", borderRadius: 1, p: 2, mt: 2, background: "#fff" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
          <Chip size="small" label="Invoice Preview" />
        </Box>
        <Typography variant="subtitle2">Buyer: {(f && f.buyer) || "-"}</Typography>
        <Typography variant="body2" color="text.secondary">Date: {(f && f.date) || "-"}</Typography>
        <Divider sx={{ my: 1 }} />
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Item</th><th align="center">Qty</th><th align="right">Rate</th><th align="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const qty = Number(it && it.qty != null ? it.qty : 0);
              const rate = Number(it && it.rate != null ? it.rate : 0);
              const hasAmount = !!(it && it.amount != null);
              const amount = hasAmount ? Number(it.amount) : qty * rate;
              const safeAmt = Number.isFinite(amount) ? amount : 0;
              return (
                <tr key={i}>
                  <td>{(it && it.name) || "Item"}</td>
                  <td align="center">{qty}</td>
                  <td align="right">₹{rate.toFixed(2)}</td>
                  <td align="right">₹{safeAmt.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: "flex", justifyContent: "space-between" }}>
          <Typography variant="body2">Taxes</Typography>
          <Typography variant="body2">₹{taxes.toFixed(2)}</Typography>
        </Box>
        <Box sx={{ display: "flex", justifyContent: "space-between" }}>
          <Typography variant="subtitle2">Total</Typography>
          <Typography variant="subtitle2">₹{total.toFixed(2)}</Typography>
        </Box>
        {f && f.paymentMode ? <Typography variant="caption" color="text.secondary">Mode: {f.paymentMode}</Typography> : null}
        {f && f.narration ? <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Narration: {f.narration}</Typography> : null}
      </Box>
    );
  }

  if (docType === "receipt") {
    const amt = Number(f && f.amount != null ? f.amount : 0);
    return (
      <Box sx={{ border: "1px dashed #ccc", borderRadius: 1, p: 2, mt: 2, background: "#fff" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
          <Chip size="small" label="Receipt Preview" />
        </Box>
        <Typography variant="subtitle2">Received From: {(f && f.receivedFrom) || "-"}</Typography>
        <Typography variant="body2" color="text.secondary">Date: {(f && f.date) || "-"}</Typography>
        <Divider sx={{ my: 1 }} />
        <Typography variant="body2">Amount: ₹{amt.toFixed(2)}</Typography>
        <Typography variant="body2">Mode: {(f && f.mode) || "Unspecified"}</Typography>
        {f && f.towards ? <Typography variant="body2">Towards: {f.towards}</Typography> : null}
        {f && f.narration ? <Typography variant="caption" color="text.secondary">Narration: {f.narration}</Typography> : null}
      </Box>
    );
  }

  const pvAmt = Number(f && f.amount != null ? f.amount : 0);
  return (
    <Box sx={{ border: "1px dashed #ccc", borderRadius: 1, p: 2, mt: 2, background: "#fff" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Chip size="small" label="Payment Voucher Preview" />
      </Box>
      <Typography variant="subtitle2">Payee: {(f && f.payee) || "-"}</Typography>
      <Typography variant="body2" color="text.secondary">Date: {(f && f.date) || "-"}</Typography>
      <Divider sx={{ my: 1 }} />
      <Typography variant="body2">Amount: ₹{pvAmt.toFixed(2)}</Typography>
      <Typography variant="body2">Mode: {(f && f.mode) || "Unspecified"}</Typography>
      {f && f.purpose ? <Typography variant="body2">Purpose: {f.purpose}</Typography> : null}
      {f && f.narration ? <Typography variant="caption" color="text.secondary">Narration: {f.narration}</Typography> : null}
    </Box>
  );
};

const PromptThreadPane = () => {
  const { thread, sessionId } = usePrompt();
  const bottomRef = useRef(null);
  const [saveStatus, setSaveStatus] = useState({});
  const [editMode, setEditMode] = useState({});       // { [cardIndex]: boolean }
  const [edits, setEdits] = useState({});             // { [cardIndex]: { [rowIndex]: patch } }

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [thread]);

  const toggleEdit = (cardIndex) => {
    const prev = !!editMode[cardIndex];
    const next = !prev;
    setEditMode((m) => ({ ...m, [cardIndex]: next }));
    if (!next) {
      // closing editor clears local edits for that card
      setEdits((e) => {
        const copy = { ...e };
        delete copy[cardIndex];
        return copy;
      });
    }
  };

  const onCellChange = (cardIndex, rowIndex, field, value) => {
    setEdits((prev) => {
      const card = prev[cardIndex] || {};
      const row = card[rowIndex] || {};
      const patch = { ...row };
      if (field === "account" || field === "narration" || field === "date") {
        patch[field] = String(value);
      } else if (field === "debit" || field === "credit") {
        const n = Number(value);
        patch[field] = Number.isFinite(n) ? n : 0;
      }
      return { ...prev, [cardIndex]: { ...card, [rowIndex]: patch } };
    });
  };

  const rePreview = async (cardIndex) => {
    const patch = edits[cardIndex] || {};
    try {
      const payload = {
        sessionId,
        // prompt intentionally omitted → backend applies `edits` to the current draft
        edits: patch
      };
      const data = await orchestrateAPI(payload);
      // Let the global updater handle adding a new PREVIEW entry in the thread
      // If your orchestrate caller is elsewhere, you can reload after this or surface a toast.
      setEditMode((m) => ({ ...m, [cardIndex]: false }));
      setEdits((e) => {
        const copy = { ...e };
        delete copy[cardIndex];
        return copy;
      });
      // no local state push here; the orchestrate entry will appear via context flow
    } catch (e) {
      console.error("Re-preview failed:", e);
      alert("Re-preview failed. Check console.");
    }
  };

  const handleSave = async (journalRows, promptText, index, docType, documentFields) => {
    try {
      const payload = {
        sessionId,
        journal: journalRows,
        prompt: typeof promptText === "string" ? promptText : "",
        confirmed: true
      };
      if (docType && docType !== "none") {
        payload.docType = docType;
        payload.documentFields = documentFields || {};
      }
      const res = await confirmEntry(payload);
      if (res && res.success === true) {
        const doc = res.document || null;
        setSaveStatus((prev) => ({ ...prev, [index]: { status: "success", document: doc } }));
      } else {
        const errMsg = res && res.error ? res.error : "Save failed";
        setSaveStatus((prev) => ({ ...prev, [index]: { status: "error", error: errMsg } }));
      }
    } catch (e) {
      const errMsg = e && e.message ? e.message : "Save failed";
      console.error("❌ Save failed:", e);
      setSaveStatus((prev) => ({ ...prev, [index]: { status: "error", error: errMsg } }));
    }
  };

  if (!Array.isArray(thread) || thread.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ p: 2 }}>
        Type a prompt above to get started.
      </Typography>
    );
  }

  return (
    <Box id="thread-pane" sx={{ maxHeight: "100%", overflowY: "auto" }}>
      {thread.map((item, idx) => {
        const kind = item && item.kind ? item.kind : null;

        // Build displayPrompt
        let displayPrompt = "";
        if (item && typeof item.prompt === "string" && item.prompt) {
          displayPrompt = item.prompt;
        } else if (item && item.raw) {
          if (typeof item.raw.originalPrompt === "string" && item.raw.originalPrompt) {
            displayPrompt = item.raw.originalPrompt;
          } else if (typeof item.raw.prompt === "string" && item.raw.prompt) {
            displayPrompt = item.raw.prompt;
          } else if (typeof item.raw.userPrompt === "string" && item.raw.userPrompt) {
            displayPrompt = item.raw.userPrompt;
          }
        }

        // doc payload
        let docType = "none";
        if (item && typeof item.docType === "string" && item.docType) {
          docType = item.docType;
        } else if (item && item.raw && typeof item.raw.docType === "string" && item.raw.docType) {
          docType = item.raw.docType;
        }
        let documentFields = {};
        if (item && item.documentFields && typeof item.documentFields === "object") {
          documentFields = item.documentFields;
        } else if (item && item.raw && item.raw.documentFields && typeof item.raw.documentFields === "object") {
          documentFields = item.raw.documentFields;
        }

        return (
          <Box key={idx} mb={3}>
            {displayPrompt ? (
              <Typography variant="subtitle2" color="primary" gutterBottom>
                💬 Prompt: {displayPrompt}
              </Typography>
            ) : null}

            {/* PREVIEW CARD */}
            {kind === "preview" && Array.isArray(item.journal) && (
              <Card variant="outlined" sx={{ backgroundColor: "#e8f5e9" }}>
                <CardContent>
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <Typography variant="subtitle2">📒 Double-Entry Journal (AI)</Typography>
                    <Box>
                      <IconButton size="small" onClick={() => toggleEdit(idx)} aria-label="edit-preview">
                        {editMode[idx] ? <CloseIcon fontSize="small" /> : <EditIcon fontSize="small" />}
                      </IconButton>
                    </Box>
                  </Box>

                  <Divider sx={{ mb: 1 }} />

                  {item.ledgerView ? (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="body2" fontFamily="monospace" whiteSpace="pre-wrap">
                        {item.ledgerView}
                      </Typography>
                    </Box>
                  ) : null}

                  {item.explanation ? (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="body2" color="text.secondary">
                        🧾 Explanation: {item.explanation}
                      </Typography>
                    </Box>
                  ) : null}

                  {Array.isArray(item.newAccounts) && item.newAccounts.length > 0 ? (
                    <Box sx={{ mb: 2 }}>
                      <Alert severity="info">🆕 Will create on save: {item.newAccounts.join(", ")}</Alert>
                    </Box>
                  ) : null}

                  {docType && docType !== "none" ? (
                    <DocumentPreview docType={docType} documentFields={documentFields} />
                  ) : null}

                  {/* Row list OR inline editor */}
                  {!editMode[idx] && item.journal.map((entry, j) => (
                    <Box key={j} sx={{ ml: 2, mb: 1 }}>
                      <Typography variant="body2">
                        • {entry.account}: <strong>Debit ₹{entry.debit || 0}</strong> /{" "}
                        <strong>Credit ₹{entry.credit || 0}</strong>
                      </Typography>
                      {entry.narration ? (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                          {entry.narration}
                        </Typography>
                      ) : null}
                    </Box>
                  ))}

                  {editMode[idx] ? (
                    <Box sx={{ mt: 1 }}>
                      {item.journal.map((row, rIdx) => {
                        const patch = (edits[idx] && edits[idx][rIdx]) || {};
                        const accountVal = (patch.account != null ? patch.account : row.account);
                        const debitVal = (patch.debit != null ? patch.debit : row.debit);
                        const creditVal = (patch.credit != null ? patch.credit : row.credit);
                        const dateVal = (patch.date != null ? patch.date : row.date);
                        const narrVal = (patch.narration != null ? patch.narration : (row.narration || ""));

                        return (
                          <Box key={rIdx} sx={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 2fr", gap: 1, mb: 1 }}>
                            <TextField size="small" label="Account" value={accountVal} onChange={(e) => onCellChange(idx, rIdx, "account", e.target.value)} />
                            <TextField size="small" label="Debit" type="number" value={debitVal} onChange={(e) => onCellChange(idx, rIdx, "debit", e.target.value)} />
                            <TextField size="small" label="Credit" type="number" value={creditVal} onChange={(e) => onCellChange(idx, rIdx, "credit", e.target.value)} />
                            <TextField size="small" label="Date (YYYY-MM-DD)" value={dateVal} onChange={(e) => onCellChange(idx, rIdx, "date", e.target.value)} />
                            <TextField size="small" label="Narration" value={narrVal} onChange={(e) => onCellChange(idx, rIdx, "narration", e.target.value)} />
                          </Box>
                        );
                      })}
                      <Box sx={{ mt: 1, display: "flex", gap: 1 }}>
                        <Button variant="outlined" onClick={() => rePreview(idx)}>Re-Preview</Button>
                        <Button variant="text" onClick={() => toggleEdit(idx)}>Cancel</Button>
                      </Box>
                    </Box>
                  ) : null}

                  {/* Confirm & Save OR doc download */}
                  <Box sx={{ mt: 2 }}>
                    {(() => {
                      const state = saveStatus[idx];
                      const isSuccess = !!(state && (state.status === "success" || state === "success"));
                      const isError = !!(state && (state.status === "error" || state === "error"));
                      const doc = state && state.document;

                      if (isSuccess) {
                        const href = doc && doc.url ? (doc.url.startsWith("http") ? doc.url : `${filesBase}${doc.url}`) : null;
                        return (
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                            <Alert severity="success">✅ Saved to ledger</Alert>
                            {href ? (
                              <>
                                <Button variant="outlined" component="a" href={href} target="_blank" rel="noreferrer">Download .docx</Button>
                                <Button variant="text" onClick={() => window.open(href, "_blank")}>Open / Print</Button>
                                {doc && doc.number ? <Chip size="small" label={`${doc.docType || "doc"}: ${doc.number}`} /> : null}
                              </>
                            ) : null}
                          </Box>
                        );
                      }
                      if (isError) {
                        return <Alert severity="error">❌ Failed to save. Try again.</Alert>;
                      }
                      return (
                        <Button
                          variant="contained"
                          onClick={() => handleSave(item.journal, displayPrompt, idx, docType, documentFields)}
                        >
                          Confirm & Save
                        </Button>
                      );
                    })()}
                  </Box>
                </CardContent>
              </Card>
            )}

            {/* FOLLOW-UP CARD */}
            {kind === "followup" && (
              <Card variant="outlined" sx={{ backgroundColor: "#fffde7" }}>
                <CardContent>
                  <Typography variant="body2" sx={{ color: "#9e8500" }}>
                    🤖 Clarification Needed: {(item && item.clarification) || "Please provide the missing detail."}
                  </Typography>
                  {item && item.docType && item.docType !== "none" ? (
                    <Typography variant="caption" color="text.secondary">
                      (for: {String(item.docType).replace("_", " ")})
                    </Typography>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </Box>
        );
      })}
      <div ref={bottomRef} />
    </Box>
  );
};

export default PromptThreadPane;
