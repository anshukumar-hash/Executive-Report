/**
 * /api/health — Studio rooftop RAG + Vini agent RAG split into the four agent
 * types (Sales IB/OB, Service IB/OB), each Green/Amber/Red/NA with ARR — the
 * layout the report shows.
 *
 * Sourced ENTIRELY from the CSM dashboard's PUBLIC /api/v1/summary endpoint
 * (ClickHouse-backed). We deliberately do NOT page /api/v1/agents — that route
 * is still behind Google auth (302), and paging it was what previously made this
 * endpoint fail. /summary is public and already carries everything we need:
 *   Studio rooftops : GET /api/v1/summary?product=studio -> .rooftops
 *   Vini agents     : GET /api/v1/summary?product=vini    -> .viniAgentsByType
 *                     { "Sales Inbound", "Sales Outbound",
 *                       "Service Inbound", "Service Outbound" }
 *
 * Config via APP_SECRETS (both optional; not needed while /summary is public):
 *   CSM_API_URL    default https://csm-dashboard.spyne.ai
 *   CSM_API_TOKEN  sent as a Bearer header when present (harmless if unset).
 */

const CSM_API_URL = (process.env.CSM_API_URL || 'https://csm-dashboard.spyne.ai').replace(/\/+$/, '');
const CSM_API_TOKEN = process.env.CSM_API_TOKEN;
const authHeaders = () => (CSM_API_TOKEN ? { Authorization: `Bearer ${CSM_API_TOKEN}` } : {});

async function getJSON(path) {
  const res = await fetch(`${CSM_API_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    throw new Error(`csm-dashboard ${path} -> HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// A /summary band block { red:{count,arr}, amber, green, na } -> report bucket.
function fromSummary(b) {
  if (!b) return null;
  const c = (k) => (b[k] && b[k].count) || 0;
  const a = (k) => (b[k] && (b[k].arr != null ? b[k].arr : (b[k].arrMinor || 0) / 100)) || 0;
  return { green: c('green'), amber: c('amber'), red: c('red'), na: c('na'),
           arr: { green: a('green'), amber: a('amber'), red: a('red') } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [studioSum, viniSum] = await Promise.all([
      getJSON('/api/v1/summary?product=studio'),
      getJSON('/api/v1/summary?product=vini'),
    ]);
    const byType = viniSum.viniAgentsByType || {};

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      source: 'csm-dashboard /api/v1/summary (public, ClickHouse-backed)',
      studio: fromSummary(studioSum.rooftops),          // Studio rooftop RAG + ARR
      salesIB: fromSummary(byType['Sales Inbound']),
      salesOB: fromSummary(byType['Sales Outbound']),
      serviceIB: fromSummary(byType['Service Inbound']),
      serviceOB: fromSummary(byType['Service Outbound']),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
