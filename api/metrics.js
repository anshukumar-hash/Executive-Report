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
 * 6. PROJECTED NEW LIVE — New Live MTD (incl. reseller/partner) + Confirmed ARR,
 *    where Confirmed ARR = sum ARR over the 3 OB tabs where "Projected Live Date"
 *    is in the current month, Stage != "Live", Stage has no "drop"/"churn", and
 *    "Current Month Confirmations" is "Confirmed" OR "Upside - Solvable"
 *    (NOT "Upside - Blocked").
 *
 * 7. PENDING TICKETS — dilipticket.vercel.app/api/tickets (Freshdesk proxy).
 *    is_pending == true, split by "Product (Studio/Vini)" (Studio* vs *Vini*).
 *
 * 8. CARR — base + New Sales MTD − CS churn − Onboarding churn.
 *    Onboarding churn: across the 3 OB tabs, rows where Stage is "OB Drop" or
 *    "Sales Drop" and "Churn / Drop-off Date" is in the current month; sum ARR.
 */

// Last month-end ARR book — rolled forward manually each month.
// AUG start = JUL month-end LARR from the July ARR walk (user, 2026-08, revised
// with the exact New-Live / Churn split by Studio·Vini and D2D·Partner):
//   Jul start        8,187,394      (Studio 6,749,214 · Vini 1,438,180)
//   + Jul New Live   +834,641.76    D2D 611,476.80 (Studio 172,000.80 · Vini 439,476.00)
//                                   + Partner 223,164.96 (Studio 219,564.96 · Vini 3,600.00)
//   − Jul churn      −339,782.28    D2D 309,747.72 (Studio 182,040.12 · Vini 127,707.60)
//                                   + Partner 30,034.56 (Studio 30,034.56 · Vini 0)
//   = Jul month-end   8,682,253.48  ← Aug starting LARR (Studio 6,928,705.08 · Vini 1,753,548.40)
// Running LARR = base − churn MTD + New Live MTD (i.e. − Aug churn during Aug).
const LARR_BASE = 8682253.48;

// PWS from the PWS tracker sheet (gid=1138324292): column Y "Current PWS" summed
// from row 4 down, split by the Product column (E) into Studio / Vini (overall =
// Studio + Vini, matches Y1). Refreshed on a short interval (10 min) — not daily.
const PWS_SHEET_ID = '16nRHqa2ym1d05WddHZR0KfnSajzkZ848J2lEu0Hu4xc';
const PWS_GID = '1138324292';
const PWS_TTL_MS = 10 * 60 * 1000;
let _pwsCache = { at: 0, data: null };
async function fetchPws() {
  const now = Date.now();
  if (_pwsCache.data && (now - _pwsCache.at) < PWS_TTL_MS) return _pwsCache.data;
  try {
    const rows = await fetchCSV(PWS_SHEET_ID, PWS_GID);
    // Header on row 3 (index 2): locate "Product" and "Current PWS" columns.
    const hdr = rows[2] || [];
    let prodCol = hdr.findIndex(h => String(h).trim().toLowerCase() === 'product');
    let yCol = hdr.findIndex(h => String(h).trim().toLowerCase() === 'current pws');
    if (prodCol === -1) prodCol = 4;   // col E fallback
    if (yCol === -1) yCol = 24;        // col Y fallback
    let studio = 0, vini = 0;
    for (let r = 3; r < rows.length; r++) {   // data from row 4 (Y4:Y)
      const row = rows[r]; if (!row) continue;
      const v = money(row[yCol]); if (!v) continue;
      const p = String(row[prodCol] || '');
      if (/vini/i.test(p)) vini += v; else if (/studio/i.test(p)) studio += v;
    }
    const total = studio + vini;
    if (total > 0) { _pwsCache = { at: now, data: { total, studio, vini } }; return _pwsCache.data; }
    return _pwsCache.data;
  } catch { return _pwsCache.data; }
}

// Legacy PWS fallback base (only used if the sheet fetch fails):
//   PWS = base + New Sales MTD − New Ob MTD.
const PWS_BASE = 3806316;

// LARR product-level opening bases (Aug-start, post-July-walk). RECONCILE to
// the overall: Studio 6,928,705.08 + Vini 1,753,548.40 = 8,682,253.48.
const STUDIO_LARR_BASE = 6928705.08, VINI_LARR_BASE = 1753548.40;

// CARR — explicit July→now walk on each product level (per user, 2026-08).
// The static July pieces below are constants; the current-month (Aug) churn and
// New Live MTD are LIVE from the data. Overall CARR = Studio + Vini.
//   Studio:  8,382,350 base
//          − 275,187  Jul revenue loss  (D2D 249,385 + reseller 18,468 + PAYG 7,334)
//          + 278,264  Jul new sales
//          + 152,316  Jul reseller                         = 8,537,743  start
//   Vini:    5,806,584 base
//          −  36,000  Vini sales drop
//          −  64,756  Jul revenue loss
//          + 685,128  Jul new sales
//          +  66,612  Jul reseller                         = 6,457,568  start
//   Running CARR (each level) = start − Aug churn (D2D) + New Live MTD (D2D+reseller).
const STUDIO_CARR_BASE = 8382350, VINI_CARR_BASE = 5806584;
const STUDIO_CARR_START = STUDIO_CARR_BASE - 275187 + 278264 + 152316;       // 8,537,743
const VINI_CARR_START   = VINI_CARR_BASE - 36000 - 64756 + 685128 + 66612;   // 6,457,568

// Monthly New Live target — the Onboarding "gap to target" tile shows
// (target − achieved) in red, with achieved below. Rolled forward manually.
const NEW_LIVE_TARGET = 1500000;

const OB_SHEET = '1ioRrooOvDSBxc7gjC2XUGjqHH_YBze_2HryOF8JWqL0';
const CHURN_SHEET = '1H5cBuWmLD_roF_LV3foWII37PHbTqqNdzCcVGeAGU8A';
const PARTNER_SHEET = '1kvvDbnpUAodPnmnLEVAWejLAzTwEflkzLSkXiAeOkB4';

const TABS = {
  vini:      { gid: '2053683245', goCol: 16, entCol: 7, pldCol: 15, confCol: 13, churnCol: 17, obCallCol: 14, obStage: 'ob initiated' },
  amer:      { gid: '1134407178', goCol: 15, entCol: 6, pldCol: 13, confCol: 12, churnCol: 16, obCallCol: 14, obStage: 'ob initiated' },
  apacEmea:  { gid: '764039413',  goCol: 21, entCol: 6, pldCol: 13, confCol: 12, churnCol: 23, obCallCol: 15, obStage: 'in implementation' },
};

const CHURN_GID = '1421999984';
const PARTNER_GID = '135115178';
const NEWSALES_GID = '1527522866';

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
  const prodIdx = header.indexOf('Product');
  let arr = 0, logos = 0;
  const studio = { arr: 0, logos: 0 }, vini = { arr: 0, logos: 0 };
  for (const r of rows.slice(2)) {
    if (r.length <= Math.max(monthIdx, arrIdx, leaderIdx)) continue;
    if ((r[monthIdx] || '').trim() !== ym) continue;
    if ((r[leaderIdx] || '').trim().toLowerCase() === 'attempting revival') continue;
    const a = money(r[arrIdx]);
    arr += a; logos++;
    const p = (prodIdx !== -1 ? (r[prodIdx] || '') : '').trim().toLowerCase();
    if (p.includes('vini')) { vini.arr += a; vini.logos++; }
    else { studio.arr += a; studio.logos++; }   // default non-Vini → Studio
  }
  return { arr, logos, studio, vini };
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
    // Count "Confirmed" AND "Upside - Solvable" (NOT "Upside - Blocked").
    const conf = (r[tab.confCol] || '').trim().toLowerCase();
    if (conf !== 'confirmed' && !(conf.includes('upside') && conf.includes('solv'))) continue;
    arr += money(r[2]);
    rooftops++;
  }
  return { arr, rooftops };
}

function partnerDeltas(rows) {
  const header = rows[0];
  const idx = header.indexOf('Delta (M-1 to M)');
  const pIdx = 4; // Product column (E): Studio / Vini; blank → Studio
  let posMRR = 0, negMRR = 0, posStudio = 0, posVini = 0, negStudio = 0, negVini = 0;
  if (idx === -1) return { posMRR, negMRR, posStudio, posVini, negStudio, negVini };
  for (const r of rows.slice(1)) {
    if (r.length <= idx || !(r[0] || '').trim()) continue;
    const v = money(r[idx]);
    const isVini = /vini/i.test((r[pIdx] || '').trim());
    if (v > 0) { posMRR += v; if (isVini) posVini += v; else posStudio += v; }
    else if (v < 0) { negMRR += v; if (isVini) negVini += v; else negStudio += v; }
  }
  return { posMRR, negMRR, posStudio, posVini, negStudio, negVini };
}

function newSales(rows, mmmYY) {
  const header = rows[0];
  const statusIdx = header.indexOf('Agreements Execution Status');
  const arrIdx = header.indexOf('ARR Potential ($)');
  const monthIdx = header.indexOf('Agreement month');
  // Product column → split Studio/Vini (Product "Vini" = Vini, everything else Studio).
  const prodIdx = header.findIndex(c => String(c).trim().toLowerCase() === 'product');
  let arr = 0, agreements = 0, studio = 0, vini = 0;
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(statusIdx, arrIdx, monthIdx)) continue;
    if ((r[statusIdx] || '').trim().toLowerCase() !== 'executed') continue;
    if ((r[monthIdx] || '').trim().toLowerCase() !== mmmYY.toLowerCase()) continue;
    const a = money(r[arrIdx]);
    arr += a; agreements++;
    const p = (prodIdx !== -1 ? (r[prodIdx] || '') : '').trim();
    if (/vini/i.test(p)) vini += a; else studio += a;
  }
  return { arr, agreements, total: arr, studio, vini };
}

// "Sent to OB" (New Ob): OB-tab rows whose OB Call Date falls in the CURRENT
// month. Sum ARR ($) (col 2). Header is CSV row 3 (index 2); data from row 4
// (index 3). The OB Call Date column index differs per tab (passed in), and the
// date format varies too — "24-Jul-25" (Vini) and "23-Jul-2025" (AMER/Non-AMER).
const MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// The OB tabs MIX date formats within the same column — dash-separated
// ("24-Jul-25", "23-Jul-2025", "22-Jun-2026") and space-separated
// ("6 Aug 2026", "21 Jul 2026"), month as 3-letter abbr or full name. Accept a
// day / month / year split on any of space, dash, or slash so none are dropped.
function parseObCallDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,})[\s\-\/]+(\d{2,4})$/);
  if (!m) return null;
  const mo = MON_IDX[m[2].slice(0, 3).toLowerCase()];
  if (mo == null) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return { y, mo };
}
function newObMtd(rows, dateCol, now) {
  const curY = now.getUTCFullYear(), curM = now.getUTCMonth();
  let arr = 0, rooftops = 0;
  for (const r of rows.slice(3)) {
    if (r.length <= Math.max(dateCol, 2)) continue;
    const d = parseObCallDate(r[dateCol]);
    if (!d || d.y !== curY || d.mo !== curM) continue;
    arr += money(r[2]);
    rooftops++;
  }
  return { arr, rooftops };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const mmm = MONTHS[now.getUTCMonth()];
  const mmmYY = `${mmm[0].toUpperCase()}${mmm.slice(1)}'${String(now.getUTCFullYear()).slice(2)}`;

  try {
    const [churnRows, viniRows, amerRows, apacRows, partnerRows, salesRows, pwsData] =
      await Promise.all([
        fetchCSV(CHURN_SHEET, CHURN_GID),
        fetchCSV(OB_SHEET, TABS.vini.gid),
        fetchCSV(OB_SHEET, TABS.amer.gid),
        fetchCSV(OB_SHEET, TABS.apacEmea.gid),
        fetchCSV(PARTNER_SHEET, PARTNER_GID),
        fetchCSV(OB_SHEET, NEWSALES_GID),
        fetchPws(),
      ]);

    // CS churn + partner churn (annualized)
    const churn = csChurn(churnRows, ym);
    const { posMRR, negMRR, posStudio, posVini, negStudio, negVini } = partnerDeltas(partnerRows);
    const partnerChurnARR = Math.abs(negMRR) * 12;
    const partnerNewARR = posMRR * 12;
    // Reseller split by Product column (blank → Studio).
    const resStudioNew = posStudio * 12, resViniNew = posVini * 12;
    const resStudioChurn = Math.abs(negStudio) * 12, resViniChurn = Math.abs(negVini) * 12;

    // New Live MTD
    const nlVini = newLive(viniRows, TABS.vini, ym);
    const nlAmer = newLive(amerRows, TABS.amer, ym);
    const nlApac = newLive(apacRows, TABS.apacEmea, ym);
    const studioNewLive = nlAmer.arr + nlApac.arr;
    const newLiveTotal = studioNewLive + nlVini.arr + partnerNewARR;

    // Per-product new-live: ALL reseller new-live goes to Studio (per user);
    // Vini new-live is its OB go-lives only.
    const studioNLP    = studioNewLive    + partnerNewARR;
    const viniNLP      = nlVini.arr;
    // GRR (proj. yearly): (1 − churn/base)^12.  NRR: (1 + (New Live − churn)/base)^12.
    const grrOf = (c, b) => b > 0 ? Math.max(0, Math.pow(1 - c / b, 12) * 100) : null;
    const nrrOf = (nl, c, b) => b > 0 ? Math.pow(1 + (nl - c) / b, 12) * 100 : null;

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
    // "Sent to OB" — OB Call Date in the current month, across all 3 OB tabs.
    const noVini = newObMtd(viniRows, TABS.vini.obCallCol, now);
    const noAmer = newObMtd(amerRows, TABS.amer.obCallCol, now);
    const noApac = newObMtd(apacRows, TABS.apacEmea.obCallCol, now);
    const newObTotal = noVini.arr + noAmer.arr + noApac.arr;

    // Onboarding churn (OB Drop + Sales Drop, drop-date in current month)
    const obcVini = obChurn(viniRows, TABS.vini, ym);
    const obcAmer = obChurn(amerRows, TABS.amer, ym);
    const obcApac = obChurn(apacRows, TABS.apacEmea, ym);
    const obChurnTotal = obcVini.arr + obcAmer.arr + obcApac.arr;

    // CARR — per-level July→now walk: static July start (constants above)
    // − Aug MTD churn (D2D) + New Live MTD (D2D+reseller). Overall = Studio+Vini.
    const carrStudio = STUDIO_CARR_START - churn.studio.arr + studioNLP;
    const carrVini   = VINI_CARR_START   - churn.vini.arr   + viniNLP;
    const carrTotal  = carrStudio + carrVini;

    const payload = {
      month: ym,
      generatedAt: now.toISOString(),
      larr: {
        base: LARR_BASE,
        // Churn = D2D only (reseller is counted as new addition, NOT churn — per user).
        churn: churn.arr,
        newLive: newLiveTotal,       // go-lives + reseller new additions
        total: LARR_BASE - churn.arr + newLiveTotal,
        studio: STUDIO_LARR_BASE - churn.studio.arr + studioNLP,
        vini: VINI_LARR_BASE - churn.vini.arr + viniNLP,
      },
      carr: {
        base: STUDIO_CARR_START + VINI_CARR_START,
        newSales: newSalesMtd.arr,
        csChurn: totalChurnARR,
        obChurn: obChurnTotal,
        obChurnRooftops: obcVini.rooftops + obcAmer.rooftops + obcApac.rooftops,
        total: carrTotal,
        studio: carrStudio,
        vini: carrVini,
      },
      // GRR / NRR on the LARR framework — churn = D2D only (reseller counts as
      // new addition, not churn), matching LARR. NRR adds New Live.
      grr: { total: grrOf(churn.arr, LARR_BASE), studio: grrOf(churn.studio.arr, STUDIO_LARR_BASE), vini: grrOf(churn.vini.arr, VINI_LARR_BASE) },
      nrr: { total: nrrOf(newLiveTotal, churn.arr, LARR_BASE), studio: nrrOf(studioNLP, churn.studio.arr, STUDIO_LARR_BASE), vini: nrrOf(viniNLP, churn.vini.arr, VINI_LARR_BASE) },
      csChurn: {
        logos: churn.logos,
        arr: churn.arr,
        partnerChurnARR,
        totalARR: churn.arr + partnerChurnARR,
        studio: churn.studio,   // { arr, logos } — Product = Studio (default)
        vini: churn.vini,       // { arr, logos } — Product = Vini
      },
      newLive: {
        // Reseller new-live all rolled into Studio (per user); Vini = OB go-lives only.
        studio: studioNewLive + partnerNewARR,
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
        // Target-gap view: how much of the monthly target is still to close.
        target: NEW_LIVE_TARGET,
        achieved: newLiveTotal + confirmedTotal,
        gap: Math.max(0, NEW_LIVE_TARGET - (newLiveTotal + confirmedTotal)),
      },
      arrInOb: {
        studio: obAmer.arr + obApac.arr,
        vini: obVini.arr,
        total: obVini.arr + obAmer.arr + obApac.arr,
        rooftops: obVini.rooftops + obAmer.rooftops + obApac.rooftops,
      },
      newSales: newSalesMtd,
      newOb: {
        vini: noVini.arr,                    // Vini OB tab
        studio: noAmer.arr + noApac.arr,     // AMER + Non-AMER OB tabs
        total: newObTotal,
        rooftops: noVini.rooftops + noAmer.rooftops + noApac.rooftops,
      },
      pws: {
        // Primary: "Current PWS" (col Y) summed by Product from the tracker sheet
        // → studio / vini / total. Fallback to the legacy formula if fetch fails.
        source: pwsData ? 'sheet:Current PWS (Y) by Product' : 'fallback:formula',
        studio: pwsData ? pwsData.studio : null,
        vini: pwsData ? pwsData.vini : null,
        base: PWS_BASE,
        newSales: newSalesMtd.arr,
        newOb: newObTotal,
        total: pwsData ? pwsData.total : (PWS_BASE + newSalesMtd.arr - newObTotal),
      },
      // Pending tickets moved to /api/support, delivery pendency to /api/delivery
      // so their slow sources don't block this core dashboard load.
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
