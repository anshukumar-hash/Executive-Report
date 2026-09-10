/**
 * /api/health — Studio & Vini rooftop RAG + Vini agent RAG (each Green/Amber/
 * Red with ARR), sourced from the CSM dashboard's authenticated API:
 *
 *   GET {CSM_API_URL}/api/v1/summary[?product=studio|vini]
 *   Authorization: Bearer {CSM_API_TOKEN}
 *
 * Replaces the old page-scrape of window.__DASHBOARD_DATA__: the CSM dashboard
 * moved to csm-dashboard.spyne.ai behind Google auth and no longer embeds that
 * blob. /api/v1/summary runs the SAME red/amber/green scoring server-side
 * (verified byte-identical to the dashboard) and returns pre-aggregated
 * buckets, so we no longer re-implement the scoring here.
 *
 * Config via APP_SECRETS:
 *   CSM_API_URL    optional, default https://csm-dashboard.spyne.ai
 *   CSM_API_TOKEN  required for this endpoint — if absent it answers 503 and
 *                  names the key, rather than failing opaquely.
 */

const CSM_API_URL = (process.env.CSM_API_URL || 'https://csm-dashboard.spyne.ai').replace(/\/+$/, '');
const CSM_API_TOKEN = process.env.CSM_API_TOKEN;

async function summary(product) {
  const url = `${CSM_API_URL}/api/v1/summary${product ? `?product=${encodeURIComponent(product)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${CSM_API_TOKEN}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`csm-dashboard /api/v1/summary?product=${product} -> HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// A /summary band block is { red:{count,arrMinor,arr}, amber, green, na, total }.
// Flatten to the { green, amber, red, na, total, arr:{...} } shape the tiles use.
function bucket(b) {
  if (!b) return null;
  const count = (k) => (b[k] && b[k].count) || 0;
  const arr = (k) => (b[k] && (b[k].arr != null ? b[k].arr : (b[k].arrMinor || 0) / 100)) || 0;
  return {
    green: count('green'), amber: count('amber'), red: count('red'), na: count('na'),
    total: b.total ? b.total.count : count('green') + count('amber') + count('red') + count('na'),
    arr: { green: arr('green'), amber: arr('amber'), red: arr('red'), na: arr('na') },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!CSM_API_TOKEN) {
    return res.status(503).json({
      error:
        'CSM_API_TOKEN is not set. Add CSM_API_TOKEN (and optionally CSM_API_URL) ' +
        'to APP_SECRETS to source health from csm-dashboard /api/v1/summary.',
    });
  }
  try {
    const [studio, vini] = await Promise.all([summary('studio'), summary('vini')]);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      source: 'csm-dashboard /api/v1/summary',
      studio: bucket(studio.rooftops), // Studio rooftop RAG + ARR
      viniRooftops: bucket(vini.rooftops), // Vini rooftop RAG + ARR
      viniAgents: bucket(vini.viniAgents), // Vini agent RAG + ARR (combined)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
