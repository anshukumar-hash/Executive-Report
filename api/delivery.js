/**
 * /api/delivery — Delivery Operations pendency (> 6 hrs): Image · Video · 360.
 *
 * Fetched from the cs-backend API, which reads the ClickHouse warehouse (this
 * dashboard's ECS task is not on the warehouse's private-endpoint allow-list,
 * so it cannot query ClickHouse directly — cs-backend can, and is public):
 *   GET {CS_BACKEND_URL}/cs-backend/api/v1/pendency/image  -> { totalPending }
 *   GET {CS_BACKEND_URL}/cs-backend/api/v1/pendency/video  -> { totalPending }
 *   GET {CS_BACKEND_URL}/cs-backend/api/v1/pendency/360    -> { meta.totals.pending }
 *
 * CS_BACKEND_URL defaults to the deployed host, so this works with no config.
 * Override CS_BACKEND_URL (or CSM_BACKEND_URL) and CS_BACKEND_TOKEN via
 * APP_SECRETS if the host moves or the API is later put behind a service token.
 */

const CS_BACKEND_URL = (process.env.CS_BACKEND_URL || process.env.CSM_BACKEND_URL || 'https://api-customer-success.spyne.ai').replace(/\/+$/, '');
const BASE = `${CS_BACKEND_URL}/cs-backend/api/v1`;
const CS_BACKEND_TOKEN = process.env.CS_BACKEND_TOKEN; // optional — the API is public today

async function getJSON(path) {
  const headers = CS_BACKEND_TOKEN ? { Authorization: `Bearer ${CS_BACKEND_TOKEN}` } : {};
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`cs-backend ${path} -> HTTP ${res.status}`);
  return res.json();
}

const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const [imagePendency, videoPendency, threeSixtyPendency] = await Promise.all([
    getJSON('/pendency/image').then((j) => numOrNull(j.totalPending)).catch(() => null),
    getJSON('/pendency/video').then((j) => numOrNull(j.totalPending)).catch(() => null),
    getJSON('/pendency/360').then((j) => numOrNull(j.meta && j.meta.totals && j.meta.totals.pending)).catch(() => null),
  ]);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: `cs-backend (${CS_BACKEND_URL})`,
    imagePendency, videoPendency, threeSixtyPendency,
  });
};
