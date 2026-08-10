/**
 * Spyne Executive Report — HTTP server for the containerised (ECS Fargate) app.
 *
 * Serves the dashboard (index.html) and the live metric APIs (api/*.js, reused
 * as-is — they are Express-compatible (req,res) handlers). Also exposes the
 * load-balancer health probe at /health.
 *
 * Runtime config comes from ONE env var, APP_SECRETS (a JSON string). It is
 * parsed and validated at startup; the process fails fast if it is missing,
 * malformed, or missing a required key. There is no production fallback.
 */
const express = require('express');
const path = require('path');

// ── Config: parse APP_SECRETS once, fail fast, expose to the handlers ─────────
// All runtime config comes from ONE env var, APP_SECRETS (a JSON string). Any
// keys it carries are copied into process.env before the handlers run, using
// their EXISTING env-var names (no new names invented).
//
// This app currently needs NO mandatory secret: every data source is a public
// URL (Google Sheets CSV, the Freshdesk proxy, the CSM dashboard, and Metabase
// PUBLIC question links). So REQUIRED_KEYS is empty. api/delivery.js accepts
// OPTIONAL overrides — METABASE_BASE_URL and the METABASE_*_PUBLIC_UUID values —
// which may be supplied through APP_SECRETS but are not required. To make a
// future key mandatory, add its exact existing env-var name to REQUIRED_KEYS and
// it will be validated at startup. Never hardcode a production fallback here.
const REQUIRED_KEYS = [];

function loadConfig() {
  const raw = process.env.APP_SECRETS;
  if (raw) {
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      console.error('FATAL: APP_SECRETS is set but is not valid JSON — ' + e.message);
      process.exit(1);
    }
    if (cfg && typeof cfg === 'object') {
      // Real env vars win over APP_SECRETS, so a platform override is possible.
      for (const [k, v] of Object.entries(cfg)) {
        if (process.env[k] === undefined) process.env[k] = String(v);
      }
      console.log('Config loaded from APP_SECRETS (' + Object.keys(cfg).length + ' key(s)).');
    }
  }
  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('FATAL: missing required config key(s): ' + missing.join(', ') +
      ' — provide them inside APP_SECRETS (a JSON string).');
    process.exit(1);
  }
}
loadConfig();

const app = express();
app.disable('x-powered-by');

// ── /health — MUST stay outside any auth. The ALB target-group health check
// hits this; it must return 200 quickly and never redirect (a redirect to a
// sign-in page reads as unhealthy → ECS kills the task in a loop). It does no
// external I/O so it stays fast and independent of upstream services.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: process.env.NAME ?? 'Executive-Report',
    timestamp: new Date().toISOString(),
  });
});

// ── Live metric APIs (Vercel-style handlers reused unchanged) ─────────────────
app.all('/api/metrics', require('./api/metrics'));
app.all('/api/health', require('./api/health'));
app.all('/api/delivery', require('./api/delivery'));
app.all('/api/support', require('./api/support'));

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log('Executive-Report listening on ' + port));
