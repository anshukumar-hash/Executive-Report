/**
 * /api/support — pending-ticket counts split by product, from the Freshdesk
 * proxy at dilipticket.vercel.app/api/tickets.
 *
 * Vini = Sales + Service (the Product column carries the renamed buckets:
 * "Sales" and "Service" are both Vini; "Studio"/"Studio - ETA" stay Studio;
 * plain "Vini", blank, "Spam", etc. are left unclassified so the Vini tile
 * always reconciles to Sales + Service).
 *
 * IMPORTANT reliability note: the AWS/ECS egress sometimes gets an EMPTY array
 * back from the proxy even though the source serves full data to browsers. To
 * avoid rendering a misleading "0":
 *   - retry a few times,
 *   - treat an empty array as a failure (not zero),
 *   - serve the last-known-good counts (stale flag) if a later fetch fails,
 *   - return pendingTickets:null when we genuinely have nothing — the frontend
 *     then falls back to fetching the source DIRECTLY from the browser (the
 *     source sets Access-Control-Allow-Origin:*), which is not affected by the
 *     ECS egress problem.
 * `sourceRows` / `sourceError` are returned as diagnostics.
 */

const TICKETS_URL = 'https://dilipticket.vercel.app/api/tickets';
const TICKETS_TIMEOUT_MS = 20000;
const ATTEMPTS = 3;

// Process-lifetime last-known-good, so a transient empty/failed fetch doesn't
// blank the tile once we've seen real data.
let _lastGood = null; // { counts, at }

async function fetchTickets() {
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TICKETS_TIMEOUT_MS);
    try {
      const r = await fetch(TICKETS_URL, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'exec-report/1.0' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (Array.isArray(data) && data.length) return data;
      lastErr = new Error('source returned empty array');
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('unknown fetch error');
}

function classify(all) {
  let studio = 0, sales = 0, service = 0, unclassified = 0;
  for (const t of all) {
    if (!t.is_pending) continue;
    const p = (t['Product (Studio/Vini)'] || '').toLowerCase();
    if (p.includes('studio')) studio++;
    else if (p.includes('service')) service++;
    else if (p.includes('sales')) sales++;
    else unclassified++;
  }
  return { studio, vini: sales + service, sales, service, unclassified };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let sourceRows = 0, sourceError = null, counts = null, stale = false;
  try {
    const all = await fetchTickets();
    sourceRows = all.length;
    counts = classify(all);
    _lastGood = { counts, at: Date.now() };
  } catch (e) {
    sourceError = e.message;
    if (_lastGood) { counts = _lastGood.counts; stale = true; } // serve last good, flagged
  }
  // Short CDN cache — we want a fresh pull soon after an empty/stale response.
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: TICKETS_URL,
    sourceRows,
    sourceError,          // null on success; set when the ECS egress got nothing
    stale,                // true when served from last-known-good after a failure
    pendingTickets: counts, // null only when we never had good data → client falls back
  });
};
