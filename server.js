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
// The api/*.js handlers read individual process.env.* values, so after parsing
// we copy each key from APP_SECRETS into process.env before they run.
const REQUIRED_KEYS = ['METABASE_API_KEY', 'METABASE_BASE_URL', 'METABASE_DATABASE_ID'];

function loadConfig() {
  const raw = process.env.APP_SECRETS;
  if (!raw) {
    console.error('FATAL: APP_SECRETS is not set. Provide it as a JSON string containing: ' + REQUIRED_KEYS.join(', '));
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error('FATAL: APP_SECRETS is not valid JSON — ' + e.message);
    process.exit(1);
  }
  const missing = REQUIRED_KEYS.filter((k) => cfg[k] == null || cfg[k] === '');
  if (missing.length) {
    console.error('FATAL: APP_SECRETS is missing required key(s): ' + missing.join(', '));
    process.exit(1);
  }
  for (const [k, v] of Object.entries(cfg)) process.env[k] = String(v);
  console.log('Config loaded from APP_SECRETS (' + Object.keys(cfg).length + ' keys).');
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
    status: 'ok',
    service: process.env.NAME,
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
