/**
 * /api/health — Studio rooftop RAG + Vini agent RAG split into the four agent
 * types (Sales IB/OB, Service IB/OB), each Green/Amber/Red with ARR — the
 * layout the report shows.
 *
 * Sourced from the CSM dashboard's v1 API, which is backed by the ClickHouse
 * warehouse (csm-dashboard-backend), NOT Metabase and NOT the old page-scrape:
 *   Studio rooftops : GET /api/v1/summary?product=studio  -> rooftops band block
 *   Vini agents     : GET /api/v1/agents (paged)          -> one row per agent,
 *                     grouped here into Sales/Service x IB/OB by the agent's
 *                     vertical string (…sales…/…service… + …inbound…/…outbound…).
 *
 * Config via APP_SECRETS:
 *   CSM_API_URL    optional, default https://csm-dashboard.spyne.ai
 *   CSM_API_TOKEN  optional — sent as a Bearer header when present.
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

const mkBucket = () => ({ green: 0, amber: 0, red: 0, na: 0, arr: { green: 0, amber: 0, red: 0 } });

// A /summary band block { red:{count,arr}, amber, green, na } -> report bucket shape.
function fromSummary(b) {
  if (!b) return null;
  const c = (k) => (b[k] && b[k].count) || 0;
  const a = (k) => (b[k] && (b[k].arr != null ? b[k].arr : (b[k].arrMinor || 0) / 100)) || 0;
  return { green: c('green'), amber: c('amber'), red: c('red'), na: c('na'),
           arr: { green: a('green'), amber: a('amber'), red: a('red') } };
}

// The agent's vertical string — try the likely fields before falling back, so an
// enterprise name that happens to contain "service" can't misclassify a row.
const VERTICAL_FIELDS = ['agent', 'agentName', 'agentType', 'vertical', 'role', 'lane', 'queue', 'type', 'name'];
function verticalOf(agent) {
  for (const k of VERTICAL_FIELDS) {
    const v = agent[k];
    if (typeof v === 'string') { const s = v.toLowerCase(); if (s.includes('sales') || s.includes('service')) return s; }
  }
  return '';
}
function classify(agent) {
  const s = verticalOf(agent);
  const ib = s.includes('inbound'), ob = s.includes('outbound');
  if (s.includes('sales')) return ib ? 'salesIB' : ob ? 'salesOB' : null;
  if (s.includes('service')) return ib ? 'serviceIB' : ob ? 'serviceOB' : null;
  return null;
}

async function allAgents() {
  const rows = [];
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const q = `/api/v1/agents?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const j = await getJSON(q);
    const page = j.data || j.agents || j.items || j.rows || [];
    rows.push(...page);
    cursor = (j.meta && (j.meta.nextCursor || j.meta.cursor)) || j.nextCursor || '';
    if (!cursor || page.length === 0) break;
  }
  return rows;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [studioSummary, agents] = await Promise.all([
      getJSON('/api/v1/summary?product=studio'),
      allAgents(),
    ]);

    const buckets = { salesIB: mkBucket(), salesOB: mkBucket(), serviceIB: mkBucket(), serviceOB: mkBucket() };
    for (const a of agents) {
      const key = classify(a);
      if (!key) continue;
      const band = String((a.health && a.health.overall) || a.health || '').toLowerCase();
      const arr = (a.arrMinor != null ? a.arrMinor / 100 : Number(a.arr) || 0);
      const b = buckets[key];
      if (band === 'green') { b.green++; b.arr.green += arr; }
      else if (band === 'amber') { b.amber++; b.arr.amber += arr; }
      else if (band === 'red') { b.red++; b.arr.red += arr; }
      else b.na++;
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      source: 'csm-dashboard /api/v1 (ClickHouse-backed)',
      studio: fromSummary(studioSummary.rooftops), // Studio rooftop RAG + ARR
      salesIB: buckets.salesIB,
      salesOB: buckets.salesOB,
      serviceIB: buckets.serviceIB,
      serviceOB: buckets.serviceOB,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
