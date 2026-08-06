/**
 * Vercel Serverless Function — /api/support
 *
 * Pending-ticket counts split by product (Vini / Studio), from the Freshdesk
 * proxy at dilipticket.vercel.app/api/tickets. Split into its own endpoint so
 * the slow ticket API (~3k rows / 2.4 MB, can take 15–20s) doesn't block the
 * main /api/metrics dashboard load — the frontend fetches this in parallel and
 * fills the Support tiles when it resolves.
 *
 * Returns null (dashboard keeps "—") only if the ticket API is unreachable or
 * exceeds the timeout below.
 */

const TICKETS_URL = 'https://dilipticket.vercel.app/api/tickets';

// The ticket proxy is slow; give it room, but stay under the serverless
// function limit so this endpoint itself never times out.
const TICKETS_TIMEOUT_MS = 25000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TICKETS_TIMEOUT_MS);
    let ticketRes;
    try {
      ticketRes = await fetch(TICKETS_URL, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!ticketRes.ok) throw new Error(`tickets -> HTTP ${ticketRes.status}`);
    const all = await ticketRes.json();

    // The Product (Studio/Vini) column now carries the renamed Vini buckets:
    // "Sales" and "Service" are both Vini (Vini = Sales + Service). Studio stays
    // Studio (incl. "Studio - ETA"). Legacy/other tags — plain "Vini",
    // "Vini - ETA", "Internal-Vini", "Spam", blank — are left unclassified so
    // the Vini tile always reconciles exactly to Sales + Service.
    let studio = 0, sales = 0, service = 0, unclassified = 0;
    for (const t of all) {
      if (!t.is_pending) continue;
      const p = (t['Product (Studio/Vini)'] || '').toLowerCase();
      if (p.includes('studio')) studio++;
      else if (p.includes('service')) service++;
      else if (p.includes('sales')) sales++;
      else unclassified++;
    }
    const vini = sales + service;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      pendingTickets: { studio, vini, sales, service, unclassified },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
