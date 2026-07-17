/**
 * Vercel Serverless Function — /api/metrics
 *
 * Recomputes every live metric on the Spyne Executive Dashboard from its
 * source of truth, so the page always shows current numbers.
 *
 * Sources & logic (as specified by leadership):
 *
 * 1. CS CHURN — CS Churn Tracker sheet, gid 1421999984
 *    Rows where "Churn/Contraction Month" == current YYYY-MM and
 *    "Leader Approved" != "Attempting Revival". Sum ARR, count logos.
 *
 * 2. NEW LIVE MTD (New Addition) — OB workbook, 3 tabs
 *    Vini (gid 2053683245, go-live col 16), Studio AMER (1134407178, col 15),
 *    Studio APAC/EMEA (764039413, col 21). Rows where Stage == "Live" and
 *    Go-Live Date month == current month. Sum ARR (col 2).
 *    PLUS partner new addition (see 4), annualized.
 *
 * 3. ARR IN OB — same 3 OB tabs.
 *    Vini + AMER: Stage == "OB Initiated". APAC/EMEA: Stage == "In Implementation".
 *    Sum ARR (col 2).
 *
 * 4. PARTNERSHIP DELTAS — Partnership sheet, gid 135115178
 *    Column "Delta (M-1 to M)" (MRR): positives ×12 add to New Live MTD,
 *    negatives ×12 add to churned revenue.
 *
 * 5. NEW SALES MTD — OB workbook, gid 1527522866
 *    Rows where "Agreements Execution Status" == "Executed" and
 *    "Agreement month" == current month as MMM'yy (e.g. Jul'26).
 *    Sum "ARR Potential ($)".
 *
 * 6. PROJECTED NEW LIVE — New Live MTD + Confirmed ARR, where Confirmed ARR =
 *    sum ARR over the 3 OB tabs where "Projected Live Date" is in the current
 *    month, Stage != "Live", Stage has no "drop"/"churn", and
 *    "Current Month Confirmations" == "Confirmed".
 *
 * 7. PENDING TICKETS — dilipticket.vercel.app/api/tickets (Freshdesk proxy).
 *    is_pending == true, split by "Product (Studio/Vini)" (Studio* vs *Vini*).
 *
 * 8. CARR — base + New Sales MTD − CS churn − Onboarding churn.
 *    Onboarding churn: across the 3 OB tabs, rows where Stage is "OB Drop" or
 *    "Sales Drop" and "Churn / Drop-off Date" is in the current month; sum ARR.
 */

// Last month-end ARR book — rolled forward manually each month (same
// convention as the CSM dashboard's EM_LARR_BASE).
const LARR_BASE = 8187394;

// PWS bucket base — rolled forward manually. PWS = base + New Sales MTD − New Ob MTD.
const PWS_BASE = 3806316;

// CARR base — rolled forward manually.
// CARR = base + New Sales MTD − CS churn − Onboarding churn.
const CARR_BASE = 6001531 + 8187394; // 14,188,925

const OB_SHEET = '1ioRrooOvDSBxc7gjC2XUGjqHH_YBze_2HryOF8JWqL0';
const CHURN_SHEET = '1H5cBuWmLD_roF_LV3foWII37PHbTqqNdzCcVGeAGU8A';
const PARTNER_SHEET = '1kvvDbnpUAodPnmnLEVAWejLAzTwEflkzLSkXiAeOkB4';

const TABS = {
  vini:      { gid: '2053683245', goCol: 16, entCol: 7, pldCol: 15, confCol: 13, churnCol: 17, obStage: 'ob initiated' },
  amer:      { gid: '1134407178', goCol: 15, entCol: 6, pldCol: 13, confCol: 12, churnCol: 16, obStage: 'ob initiated' },
  apacEmea:  { gid: '764039413',  goCol: 21, entCol: 6, pldCol: 13, confCol: 12, churnCol: 23, obStage: 'in implementation' },
};

const CHURN_GID = '1421999984';
const PARTNER_GID = '135115178';
const NEWSALES_GID = '1527522866';
const TICKETS_URL = 'https://dilipticket.vercel.app/api/tickets';

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// ─── CSV parsing (quote-aware, handles newlines inside quotes) ──────────────
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchCSV(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CSV fetch ${gid} -> HTTP ${res.status}`);
  return parseCSV(await res.text());
}

// ─── Value parsing ───────────────────────────────────────────────────────────
function money(s) {
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s.trim());
  const v = String(s).replace(/[^0-9.\-]/g, '');
  if (v === '' || v === '-' || v === '.') return 0;
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return neg && n > 0 ? -n : n;
}

// Parse any of: 8-Jul-26, 11-Jul-2026, 16-July-2026, 23 Jul 2026, 2026-07-08,
// 07/08/2026 (US), Jul'26 — to "YYYY-MM"; null if unparseable.
function toYM(s) {
  if (!s) return null;
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ,]+(\d{2,4})$/);
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    let yr = +m[3]; if (yr < 100) yr += 2000;
    if (mon) return `${yr}-${String(mon).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yr = +m[3]; if (yr < 100) yr += 2000;
    return `${yr}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3,})[' -]+(\d{2,4})$/);
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    let yr = +m[2]; if (yr < 100) yr += 2000;
    if (mon) return `${yr}-${String(mon).padStart(2, '0')}`;
  }
  return null;
}

// ─── Metric computations ─────────────────────────────────────────────────────
function csChurn(rows, ym) {
  // Row 0 = summary, row 1 = header, data from row 2.
  const header = rows[1];
  const monthIdx = header.indexOf('Churn/Contraction Month');
  const arrIdx = header.indexOf('ARR');
  const leaderIdx = header.indexOf('Leader Approved');
  let arr = 0, logos = 0;
  for (const r of rows.slice(2)) {
    if (r.length <= Math.max(monthIdx, arrIdx, leaderIdx)) continue;
    if ((r[monthIdx] || '').trim() !== ym) continue;
    if ((r[leaderIdx] || '').trim().toLowerCase() === 'attempting revival') continue;
    arr += money(r[arrIdx]);
    logos++;
  }
  return { arr, logos };
}

// OB tab rows: row 0 totals, row 1 subheader, row 2 header, data from row 3.
function newLive(rows, tab, ym) {
  let arr = 0, rooftops = 0;
  const ents = new Set();
  for (const r of rows.slice(3)) {
    if (r.length <= Math.max(tab.goCol, tab.entCol, 4)) continue;
    if ((r[4] || '').trim().toLowerCase() !== 'live') continue;
    if (toYM(r[tab.goCol]) !== ym) continue;
    arr += money(r[2]);
    rooftops++;
    const id = (r[tab.entCol] || '').trim();
    if (id) ents.add(id);
  }
  return { arr, rooftops, ents };
}

function arrInOb(rows, tab) {
  let arr = 0, rooftops = 0;
  for (const r of rows.slice(3)) {
    if (r.length <= 4) continue;
    if ((r[4] || '').trim().toLowerCase() !== tab.obStage) continue;
    arr += money(r[2]);
    rooftops++;
  }
  return { arr, rooftops };
}

// Onboarding churn: OB tab rows where Stage is "OB Drop" or "Sales Drop" and the
// "Churn / Drop-off Date" (per-tab churnCol) falls in the current month. Sum ARR (col 2).
function obChurn(rows, tab, ym) {
  let arr = 0, rooftops = 0;
  for (const r of rows.slice(3)) {
    if (r.length <= Math.max(tab.churnCol, 4)) continue;
    const stage = (r[4] || '').trim().toLowerCase();
    if (stage !== 'ob drop' && stage !== 'sales drop') continue;
    if (toYM(r[tab.churnCol]) !== ym) continue;
    arr += money(r[2]);
    rooftops++;
  }
  return { arr, rooftops };
}

function confirmedARR(rows, tab, ym) {
  let arr = 0, rooftops = 0;
  for (const r of rows.slice(3)) {
    if (r.length <= Math.max(tab.pldCol, tab.confCol, 4)) continue;
    const stage = (r[4] || '').trim().toLowerCase();
    if (!stage || stage === 'live' || stage.includes('drop') || stage.includes('churn')) continue;
    if (toYM(r[tab.pldCol]) !== ym) continue;
    if ((r[tab.confCol] || '').trim().toLowerCase() !== 'confirmed') continue;
    arr += money(r[2]);
    rooftops++;
  }
  return { arr, rooftops };
}

function partnerDeltas(rows) {
  const header = rows[0];
  const idx = header.indexOf('Delta (M-1 to M)');
  let posMRR = 0, negMRR = 0;
  if (idx === -1) return { posMRR, negMRR };
  for (const r of rows.slice(1)) {
    if (r.length <= idx || !(r[0] || '').trim()) continue;
    const v = money(r[idx]);
    if (v > 0) posMRR += v;
    else if (v < 0) negMRR += v;
  }
  return { posMRR, negMRR };
}

function newSales(rows, mmmYY) {
  const header = rows[0];
  const statusIdx = header.indexOf('Agreements Execution Status');
  const arrIdx = header.indexOf('ARR Potential ($)');
  const monthIdx = header.indexOf('Agreement month');
  let arr = 0, agreements = 0;
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(statusIdx, arrIdx, monthIdx)) continue;
    if ((r[statusIdx] || '').trim().toLowerCase() !== 'executed') continue;
    if ((r[monthIdx] || '').trim().toLowerCase() !== mmmYY.toLowerCase()) continue;
    arr += money(r[arrIdx]);
    agreements++;
  }
  return { arr, agreements };
}

// New Ob MTD: OB tab rows whose "In-Ob from" is "From PWS" or "From New Sales"
// (header row is CSV row 2; data from row 3). Sum ARR (col 2).
function newObMtd(rows) {
  const header = rows[2] || [];
  const idx = header.findIndex(h => h.trim().toLowerCase() === 'in-ob from');
  if (idx === -1) return { arr: 0, rooftops: 0 };
  let arr = 0, rooftops = 0;
  for (const r of rows.slice(3)) {
    if (r.length <= idx) continue;
    const v = (r[idx] || '').trim();
    if (v === 'From PWS' || v === 'From New Sales') {
      arr += money(r[2]);
      rooftops++;
    }
  }
  return { arr, rooftops };
}

async function pendingTickets() {
  // The ticket proxy returns ~3k rows and is the slowest source; cap it so it
  // can't drag the whole /api/metrics response (CARR etc. don't depend on it).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(TICKETS_URL, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`tickets -> HTTP ${res.status}`);
  const all = await res.json();
  let studio = 0, vini = 0, unclassified = 0;
  for (const t of all) {
    if (!t.is_pending) continue;
    const p = (t['Product (Studio/Vini)'] || '').toLowerCase();
    if (p.includes('studio')) studio++;
    else if (p.includes('vini')) vini++;
    else unclassified++;
  }
  return { studio, vini, unclassified };
}

// ─── Metabase — Delivery · Image pendency ─────────────────────────────────────
// Reads a saved Metabase card (a scalar/count question) and returns its number.
// Configured via env: METABASE_BASE_URL, METABASE_API_KEY, METABASE_CARD_ID
// (set in .env.local locally, and in Vercel → Settings → Environment Variables).
// Returns null if unconfigured or the request fails — dashboard keeps "—".
async function metabaseImagePendency() {
  const base = (process.env.METABASE_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.METABASE_API_KEY;
  const card = process.env.METABASE_CARD_ID;
  if (!base || !key || !card) return null;
  const res = await fetch(`${base}/api/card/${card}/query/json`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`metabase card ${card} -> HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  // Scalar card: take a column mentioning "image", else the first numeric value.
  const row = rows[0];
  const imgKey = Object.keys(row).find(k => /image/i.test(k));
  const raw = imgKey != null
    ? row[imgKey]
    : Object.values(row).find(v => v != null && v !== '' && !isNaN(Number(v)));
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const mmm = MONTHS[now.getUTCMonth()];
  const mmmYY = `${mmm[0].toUpperCase()}${mmm.slice(1)}'${String(now.getUTCFullYear()).slice(2)}`;

  try {
    const [churnRows, viniRows, amerRows, apacRows, partnerRows, salesRows, tickets, imagePendency] =
      await Promise.all([
        fetchCSV(CHURN_SHEET, CHURN_GID),
        fetchCSV(OB_SHEET, TABS.vini.gid),
        fetchCSV(OB_SHEET, TABS.amer.gid),
        fetchCSV(OB_SHEET, TABS.apacEmea.gid),
        fetchCSV(PARTNER_SHEET, PARTNER_GID),
        fetchCSV(OB_SHEET, NEWSALES_GID),
        pendingTickets().catch(() => null),
        metabaseImagePendency().catch(() => null),
      ]);

    // CS churn + partner churn (annualized)
    const churn = csChurn(churnRows, ym);
    const { posMRR, negMRR } = partnerDeltas(partnerRows);
    const partnerChurnARR = Math.abs(negMRR) * 12;
    const partnerNewARR = posMRR * 12;

    // New Live MTD
    const nlVini = newLive(viniRows, TABS.vini, ym);
    const nlAmer = newLive(amerRows, TABS.amer, ym);
    const nlApac = newLive(apacRows, TABS.apacEmea, ym);
    const studioNewLive = nlAmer.arr + nlApac.arr;
    const newLiveTotal = studioNewLive + nlVini.arr + partnerNewARR;

    // ARR in Ob
    const obVini = arrInOb(viniRows, TABS.vini);
    const obAmer = arrInOb(amerRows, TABS.amer);
    const obApac = arrInOb(apacRows, TABS.apacEmea);

    // Confirmed / Projected New Live
    const cVini = confirmedARR(viniRows, TABS.vini, ym);
    const cAmer = confirmedARR(amerRows, TABS.amer, ym);
    const cApac = confirmedARR(apacRows, TABS.apacEmea, ym);
    const confirmedTotal = cVini.arr + cAmer.arr + cApac.arr;

    const totalChurnARR = churn.arr + partnerChurnARR;

    // New Sales MTD (executed agreements this month)
    const newSalesMtd = newSales(salesRows, mmmYY);

    // New Ob MTD (Vini + Studio AMER) and derived PWS
    const noVini = newObMtd(viniRows);
    const noAmer = newObMtd(amerRows);
    const newObTotal = noVini.arr + noAmer.arr;

    // Onboarding churn (OB Drop + Sales Drop, drop-date in current month)
    const obcVini = obChurn(viniRows, TABS.vini, ym);
    const obcAmer = obChurn(amerRows, TABS.amer, ym);
    const obcApac = obChurn(apacRows, TABS.apacEmea, ym);
    const obChurnTotal = obcVini.arr + obcAmer.arr + obcApac.arr;

    // CARR = base + New Sales MTD − CS churn − Onboarding churn.
    // CS churn here mirrors the CS row's "Churned Revenue" (CS Tracker + partner).
    const carrTotal = CARR_BASE + newSalesMtd.arr - totalChurnARR - obChurnTotal;

    const payload = {
      month: ym,
      generatedAt: now.toISOString(),
      larr: {
        base: LARR_BASE,
        churn: totalChurnARR,
        newLive: newLiveTotal,
        total: LARR_BASE - totalChurnARR + newLiveTotal,
      },
      carr: {
        base: CARR_BASE,
        newSales: newSalesMtd.arr,
        csChurn: totalChurnARR,
        obChurn: obChurnTotal,
        obChurnRooftops: obcVini.rooftops + obcAmer.rooftops + obcApac.rooftops,
        total: carrTotal,
      },
      csChurn: {
        logos: churn.logos,
        arr: churn.arr,
        partnerChurnARR,
        totalARR: churn.arr + partnerChurnARR,
      },
      newLive: {
        studio: studioNewLive,
        vini: nlVini.arr,
        partner: partnerNewARR,
        total: newLiveTotal,
        rooftops: nlVini.rooftops + nlAmer.rooftops + nlApac.rooftops,
      },
      projectedNewLive: {
        live: newLiveTotal,
        confirmed: confirmedTotal,
        total: newLiveTotal + confirmedTotal,
        confirmedRooftops: cVini.rooftops + cAmer.rooftops + cApac.rooftops,
      },
      arrInOb: {
        studio: obAmer.arr + obApac.arr,
        vini: obVini.arr,
        total: obVini.arr + obAmer.arr + obApac.arr,
        rooftops: obVini.rooftops + obAmer.rooftops + obApac.rooftops,
      },
      newSales: newSalesMtd,
      newOb: {
        vini: noVini.arr,
        studio: noAmer.arr,
        total: newObTotal,
        rooftops: noVini.rooftops + noAmer.rooftops,
      },
      pws: {
        base: PWS_BASE,
        newSales: newSalesMtd.arr,
        newOb: newObTotal,
        total: PWS_BASE + newSalesMtd.arr - newObTotal,
      },
      pendingTickets: tickets, // null if the ticket API was unreachable
      delivery: {
        imagePendency, // null if Metabase unreachable/unconfigured
      },
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
