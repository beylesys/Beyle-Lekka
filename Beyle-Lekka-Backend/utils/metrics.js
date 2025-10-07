// utils/metrics.js
// ESM + Node 22. Graceful if 'prom-client' is not installed.
// Exports: { histograms, metricsHandler, timeAsync } and default with same keys.

let client = null;
let registry = null;
let hist = null;

function makeNoopHistogram() {
  return {
    startTimer() {
      const t0 = process.hrtime.bigint();
      return () => { void t0; /* no-op */ };
    },
    observe() { /* no-op */ },
    labels() { return makeNoopHistogram(); },
  };
}

const noop = {
  hPreview:        makeNoopHistogram(),
  hPost:           makeNoopHistogram(),
  hReco:           makeNoopHistogram(),
  hImportPreview:  makeNoopHistogram(),
  hImportCommit:   makeNoopHistogram(),
};

// Try to load prom-client dynamically so missing dependency doesn't crash boot.
try {
  const mod = await import("prom-client");
  client = mod.default ?? mod;
  registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  function makeDurationHistogram(name, help, labelNames = ["route", "workspace"]) {
    return new client.Histogram({
      name, help, labelNames,
      buckets: [0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 6, 10],
      registers: [registry],
    });
  }

  const hPreview       = makeDurationHistogram("je_preview_duration_seconds",
    "Time to generate a JE preview (excluding LLM if measured separately)");
  const hPost          = makeDurationHistogram("je_post_duration_seconds",
    "Time to confirm and post a JE (DB work only)");
  const hReco          = makeDurationHistogram("bank_reco_duration_seconds",
    "Time to perform reconciliation ops");
  const hImportPreview = makeDurationHistogram("import_preview_duration_seconds",
    "Time to parse/preview an import");
  const hImportCommit  = makeDurationHistogram("import_commit_duration_seconds",
    "Time to commit an import");

  hist = { hPreview, hPost, hReco, hImportPreview, hImportCommit };
} catch {
  hist = { ...noop };
}

/** Run an async fn and time it if metrics are enabled. */
async function timeAsync(histogram, labels, fn) {
  if (!client) return await fn();
  const end = histogram.startTimer(labels || {});
  try { return await fn(); } finally { try { end(); } catch {} }
}

/** Express handler for /metrics */
async function metricsHandler(_req, res) {
  if (!client || !registry) {
    res.status(501).type("text/plain").send("# metrics disabled (prom-client not installed)\n");
    return;
  }
  res.setHeader("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}

export const histograms = hist;
export { timeAsync, metricsHandler };

const Metrics = { histograms, timeAsync, metricsHandler };
export default Metrics;
