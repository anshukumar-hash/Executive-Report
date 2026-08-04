/**
 * Vercel Serverless Function — /api/health
 *
 * Live Studio rooftop health + Vini agent health (Sales / Service split),
 * computed with a faithful port of the CSM dashboard's Overall RAG logic
 * (studioRooftopOverallRag / viniAgentOverallRag / viniAggregateRooftops).
 *
 * Data source: the deployed CSM dashboard itself. Its GitHub-Action sync bakes
 * every input (rooftop rows, ticket dumps, CSAT history, Vini stage + daily
 * rows) into `window.__DASHBOARD_DATA__` inside the published index.html —
 * this function fetches that page, extracts the JSON blob, and re-runs the
 * same scoring math. Report-sent tracking comes from the same public Supabase
 * REST endpoint the dashboard queries client-side.
 *
 * Scoring (mirrors the dashboard exactly):
 *   Per-signal score: Green=100, Amber=60, Orange=40, Red=20; NA excluded
 *   from numerator AND denominator. Composite: ≥80 G · ≥60 A · else R.
 *   Studio rooftop: usage(3) payment(3) ticket(2) comm(2)
 *     usage  = VIN-series trend Jan..Jun (slope/mean: >+5% G · <-5% R · else A)
 *     payment= r.prag (worst of T-1/T-2/T-3)
 *     ticket = worst per-priority age-vs-SLA across OPEN tickets (MTD window)
 *     comm   = avg CSAT in MTD (<2.5 R · <4 A · ≥4 G)
 *   Vini agent: roi(3) payment(3) comm(2) ticket(2) reportSent(2)
 *     roi    = MTD appt value ÷ prorated MTD MRR (≥4 G · ≥2 A · >0 R · 0 NA)
 *     reportSent = yesterday's RoI digest (sent G · else R · no data NA)
 */

const CSM_DASH_URL = 'https://customersuccessoperativedashboard.vercel.app/';
const ROI_DIGEST_URL = 'https://qludnojfibguobgeeujw.supabase.co/rest/v1/roi_digest_runs';
// Public anon key — shipped verbatim in the public CSM dashboard page.
const ROI_DIGEST_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsdWRub2pmaWJndW9iZ2VldWp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMTU2NzgsImV4cCI6MjA5NjY5MTY3OH0.6lnQjCn48GCVkhQ6TVcb25BiBiaTVSass9h_ekvURlw';

const OVERALL_RAG_VALUE = { Green: 100, Amber: 60, Orange: 40, Red: 20 };
const SLA_THRESHOLDS_HRS = {
  urgent: { green: 6,   amber: 48,  orange: 72  },
  high:   { green: 24,  amber: 72,  orange: 120 },
  medium: { green: 120, amber: 168, orange: 240 },
  low:    { green: 360, amber: 480, orange: 720 },
};
const APPT_VALUE_BY_AGENT = {
  'Sales Inbound': 100, 'Sales Outbound': 250,
  'Service Inbound': 50, 'Service Outbound': 75,
};
const apptValuePerAppt = a => APPT_VALUE_BY_AGENT[a] != null ? APPT_VALUE_BY_AGENT[a] : 100;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mtdRange(today) {
  return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
}

function _ragValue(r) { return r && OVERALL_RAG_VALUE[r] != null ? OVERALL_RAG_VALUE[r] : null; }
function blend(parts, weights) {
  let sum = 0, wu = 0;
  for (const k of Object.keys(weights)) {
    const v = _ragValue(parts[k]);
    if (v == null) continue;
    sum += v * weights[k]; wu += weights[k];
  }
  if (!wu) return 'NA';
  const s = sum / wu;
  return s >= 80 ? 'Green' : s >= 60 ? 'Amber' : 'Red';
}

function ticketAgeRag(priority, ageHrs) {
  const p = String(priority || '').trim().toLowerCase();
  const key = ['urgent', 'high', 'medium', 'low'].includes(p)
    ? p : (p.startsWith('urg') ? 'urgent' : p.startsWith('high') ? 'high' :
           p.startsWith('low') ? 'low' : 'medium');
  const th = SLA_THRESHOLDS_HRS[key];
  const a = Number(ageHrs) || 0;
  if (a <= th.green) return 'Green';
  if (a <= th.amber) return 'Amber';
  if (a <= th.orange) return 'Orange';
  return 'Red';
}
const ragSeverity = r => r === 'Red' ? 4 : r === 'Orange' ? 3 : r === 'Amber' ? 2 : r === 'Green' ? 1 : 0;

// Worst-of-open-tickets RAG for one enterprise, MTD window (port of
// aggregateTicketsForEids + computeTicketRAG for the single-eid case).
function enterpriseTicketRag(eid, tixDict, range) {
  const tx = eid && tixDict[eid];
  if (!tx || !Array.isArray(tx.rows)) return 'NA';
  let cr = 0, op = 0, sla = 0, worstSev = 0, worstRag = null, anyPriority = false;
  for (const t of tx.rows) {
    if (!t.c || t.c < range.from || t.c > range.to) continue;
    cr++;
    if (t.s) sla++;
    if (t.o) {
      op++;
      if (t.p) {
        anyPriority = true;
        const tr = ticketAgeRag(t.p, Number(t.a) || 0);
        const sev = ragSeverity(tr);
        if (sev > worstSev) { worstSev = sev; worstRag = tr; }
      }
    }
  }
  if (cr === 0) return 'NA';
  if (op === 0) return 'Green';
  if (anyPriority) return worstRag || 'Green';
  return sla > 0 ? 'Red' : 'Amber';
}

function normCsatName(s) {
  if (!s) return '';
  let t = String(s);
  const dash = t.indexOf(' - ');
  if (dash >= 0) t = t.substring(0, dash);
  return t.trim().toLowerCase();
}
function makeCsatRag(byEid, byName, range) {
  const tryArr = arr => {
    if (!arr || !arr.length) return undefined;
    const inRange = arr.filter(r => r.date_iso && r.date_iso >= range.from && r.date_iso <= range.to);
    if (!inRange.length) return undefined;
    const avgs = inRange
      .filter(r => r.avg != null && r.avg !== '')
      .map(r => Number(r.avg))
      .filter(v => !isNaN(v));
    if (!avgs.length) return undefined;
    const v = avgs.reduce((s, x) => s + x, 0) / avgs.length;
    return v < 2.5 ? 'Red' : v < 4 ? 'Amber' : 'Green';
  };
  return (eid, en) => {
    const a = eid ? tryArr(byEid[eid]) : undefined;
    if (a != null) return a;
    const k = en ? normCsatName(en) : '';
    const b = k ? tryArr(byName[k]) : undefined;
    return b != null ? b : null;
  };
}

function usageTrendRag(series) {
  const ys = (series || []).map(v => Number(v) || 0);
  const n = ys.length;
  let trend = 'Steady';
  if (n >= 2) {
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const mx = (n - 1) / 2;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) * (i - mx); }
    if (den !== 0) {
      const slope = num / den;
      if (my <= 0) trend = ys.some(v => v > 0) ? 'Rising' : 'Steady';
      else {
        const rel = slope / my;
        trend = rel > 0.05 ? 'Rising' : rel < -0.05 ? 'Declining' : 'Steady';
      }
    }
  }
  return trend === 'Rising' ? 'Green' : trend === 'Declining' ? 'Red' : 'Amber';
}

// RoI Factor → RAG. Matches the CSM dashboard exactly: >=3 Green, >=1.5 Amber,
// else Red; 0/missing → NA (excluded from the aggregate).
const roiMtdRag = v =>
  (v == null || v === 0 || isNaN(v)) ? 'NA' : v >= 3 ? 'Green' : v >= 1.5 ? 'Amber' : 'Red';

// Vini Overall RAG — a faithful port of the CSM dashboard's viniOverallRag:
// TWO signals only, RoI (weight 7) + Communication (weight 3); payment/ticket/
// report are NOT factors for Vini. Each signal G=100/A=60/R=20; NA excluded.
// Override: an Amber RoI with no comms signal degrades to Red. All-NA → NA.
function viniOverallRag(roiMtd, commRag) {
  const roiRag = roiMtdRag(roiMtd);
  if (roiRag === 'Amber' && (commRag == null || commRag === 'NA')) return 'Red';
  const W = { roi: 7, comm: 3 };
  const parts = { roi: roiRag, comm: commRag };
  let sum = 0, wu = 0;
  for (const k in W) { const v = _ragValue(parts[k]); if (v == null) continue; sum += v * W[k]; wu += W[k]; }
  if (!wu) return 'NA';
  const s = sum / wu;
  return s >= 80 ? 'Green' : s >= 60 ? 'Amber' : 'Red';
}

// Communication RAG for a Vini agent — CSM's count-weighted CSAT scoreRag over a
// date window. Counts Green/Amber/Red readings (NA excluded), scores
// G=100/A=60/R=20, thresholds 80 Green / 60 Amber. eid first, then name key.
function makeViniComm(byEid, byName) {
  const collect = (arr, from, to) => {
    const out = {};
    for (const r of (arr || [])) {
      const di = r.date_iso;
      if (di && di >= from && di <= to) {
        const k = r.rag;
        if (k && k !== 'NA') out[k] = (out[k] || 0) + 1;
      }
    }
    return out;
  };
  const scoreVal = c => {
    const g = c.Green || 0, a = c.Amber || 0, r = c.Red || 0, t = g + a + r;
    return t === 0 ? null : (g * 100 + a * 60 + r * 20) / t;
  };
  return (eid, en, from, to) => {
    let c = eid ? collect(byEid[eid], from, to) : {};
    if (!Object.keys(c).length) c = en ? collect(byName[normCsatName(en)], from, to) : {};
    const s = scoreVal(c);
    return s == null ? 'NA' : s >= 80 ? 'Green' : s >= 60 ? 'Amber' : 'Red';
  };
}

// ─── Data acquisition ────────────────────────────────────────────────────────
async function fetchDashboardData() {
  const res = await fetch(CSM_DASH_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CSM dashboard fetch -> HTTP ${res.status}`);
  const html = await res.text();
  const marker = 'window.__DASHBOARD_DATA__ = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('__DASHBOARD_DATA__ not found in CSM dashboard page');
  const from = start + marker.length;
  const end = html.indexOf('\n', from);
  return JSON.parse(html.slice(from, end).replace(/;\s*$/, ''));
}

// (Vini agents no longer use Metabase — the universe + RoI + payment all come
// from the CSM dashboard's embedded snapshot: vini_stage + v_rows + csat. See
// the handler's VINI section.)

async function fetchReportTracking(today) {
  // Last 7 days of roi_digest_runs → rid -> { 'YYYY-MM-DD': 'sent'|... }
  try {
    const d = new Date(today); d.setDate(d.getDate() - 6);
    const url = `${ROI_DIGEST_URL}?local_date=gte.${ymd(d)}&cadence=eq.daily`
      + `&select=team_id,local_date,department,status&apikey=${ROI_DIGEST_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const rows = await res.json();
    const byRid = {};
    for (const row of rows) {
      const rid = row.team_id != null ? String(row.team_id).trim() : '';
      if (!rid) continue;
      const map = byRid[rid] = byRid[rid] || {};
      const dd = row.local_date, s = String(row.status || '');
      if (map[dd] === 'sent') continue;
      if (s === 'sent') { map[dd] = 'sent'; continue; }
      if (s === 'suppressed') { map[dd] = 'suppressed'; continue; }
      if (!map[dd]) map[dd] = s;
    }
    return byRid;
  } catch { return {}; }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const range = mtdRange(today);

    const [D, reportTracking] = await Promise.all([
      fetchDashboardData(),
      fetchReportTracking(today),
    ]);

    const csatRag = makeCsatRag(D.csat_all_by_eid || {}, D.csat_all_by_name || {}, range);
    const viniComm = makeViniComm(D.csat_all_by_eid || {}, D.csat_all_by_name || {});
    const STUDIO_TIX = D.studio_tix || {};
    const VINI_TIX = D.vini_tix || {};

    // ── STUDIO rooftop health ──
    const S_COL = {}; (D.s_schema || []).forEach((k, i) => S_COL[k] = i);
    const sRows = D.s_rows || [];
    // (s_schema carries no churn column — the dashboard's churn filter is a
    // no-op on this snapshot; every row counts, matching its own output.)
    const sTixMemo = {};
    const studio = { green: 0, amber: 0, red: 0, na: 0, rooftops: sRows.length,
                     arr: { green: 0, amber: 0, red: 0 } };
    for (const r of sRows) {
      const eid = r[S_COL.eid] || r[S_COL.en];
      if (!(eid in sTixMemo)) sTixMemo[eid] = enterpriseTicketRag(eid, STUDIO_TIX, range);
      const g = blend({
        usage: usageTrendRag([r[S_COL.u_jan], r[S_COL.u_feb], r[S_COL.u_mar],
                              r[S_COL.u_apr], r[S_COL.u_may], Number(r[S_COL.u_jun]) || 0]),
        payment: r[S_COL.prag],
        ticket: sTixMemo[eid],
        comm: csatRag(r[S_COL.eid], r[S_COL.en]),
      }, { usage: 3, payment: 3, comm: 2, ticket: 2 });
      const arr = Number(r[S_COL.arr]) || 0;
      if (g === 'Green') { studio.green++; studio.arr.green += arr; }
      else if (g === 'Amber') { studio.amber++; studio.arr.amber += arr; }
      else if (g === 'Red') { studio.red++; studio.arr.red += arr; }
      else studio.na++;
    }

    // ── VINI agents — sourced ENTIRELY from the CSM dashboard snapshot (no
    // Metabase). Universe = vini_stage (one row per rooftop×agent), Live-only.
    // RoI Factor = (appointments × $-per-appt, folded from v_rows over a trailing
    // 30-day window) ÷ MRR. Communication = count-weighted CSAT over the same
    // window. Overall RAG = viniOverallRag (RoI weight 7 + Comm weight 3), a
    // faithful port of the CSM dashboard. A trailing-30-day window (anchored at
    // the latest day in v_rows) is used instead of calendar MTD so the tiles stay
    // populated even before the current month's data has synced.
    const VINI_STAGE = Array.isArray(D.vini_stage) ? D.vini_stage
      : (D.vini_stage && Array.isArray(D.vini_stage.value) ? D.vini_stage.value : []);
    const V_COL = {}; (D.v_schema || []).forEach((k, i) => V_COL[k] = i);
    const vRows = D.v_rows || [];

    // Trailing-30-day window anchored at the latest day present in v_rows.
    let maxDay = '';
    for (const r of vRows) { const dd = r[V_COL.day]; if (dd && dd > maxDay) maxDay = dd; }
    let winTo = maxDay || range.to, winFrom = range.from;
    if (maxDay) {
      const md = new Date(maxDay + 'T00:00:00'); md.setDate(md.getDate() - 29);
      winFrom = ymd(md);
    }

    // Appointment value per (rid|agent) over the window: Σ appts × $-per-appt.
    const apptWin = {};
    for (const r of vRows) {
      const dd = r[V_COL.day];
      if (!dd || dd < winFrom || dd > winTo) continue;
      const rid = r[V_COL.rid], agent = r[V_COL.agent];
      if (!rid || !agent) continue;
      const k = rid + '|' + agent;
      apptWin[k] = (apptWin[k] || 0) + (Number(r[V_COL.a]) || 0) * apptValuePerAppt(agent);
    }

    const mkBucket = () => ({ green: 0, amber: 0, red: 0, na: 0, agents: 0, totalArr: 0,
                              arr: { green: 0, amber: 0, red: 0 } });
    // Split Vini agents into the four agent types: Sales IB/OB, Service IB/OB.
    const salesIB = mkBucket(), salesOB = mkBucket(),
          serviceIB = mkBucket(), serviceOB = mkBucket(), other = mkBucket();
    const pick = agent => {
      const a = String(agent || '').toLowerCase();
      const inbound = a.includes('inbound'), outbound = a.includes('outbound');
      if (a.includes('sales')) return inbound ? salesIB : outbound ? salesOB : other;
      if (a.includes('service')) return inbound ? serviceIB : outbound ? serviceOB : other;
      return other;
    };
    for (const s of VINI_STAGE) {
      if (!s.rid || String(s.stage || '').toLowerCase() !== 'live') continue;
      const mrr = Number(s.mrr) || 0, arr = Number(s.arr) || 0;
      const apptValue = apptWin[s.rid + '|' + (s.agent || '')] || 0;
      const roi = mrr > 0 ? apptValue / mrr : 0;   // 30-day window ≈ one month → no MRR proration
      const g = viniOverallRag(roi, viniComm(s.eid, s.en, winFrom, winTo));
      const b = pick(s.agent);
      b.agents++; b.totalArr += arr;
      // NA excluded from Green/Amber/Red counts — matches the CSM dashboard.
      if (g === 'Green') { b.green++; b.arr.green += arr; }
      else if (g === 'Amber') { b.amber++; b.arr.amber += arr; }
      else if (g === 'Red') { b.red++; b.arr.red += arr; }
      else b.na++;
    }

    // ── Company GRR & NRR (ported from the CSM dashboard, overall scope) ──
    // GRR (Projected Yearly, compounded): (1 − churn/base)^12, base fixed at
    //   7,732,095 for the unfiltered overall headline.
    // NRR (Projected Yearly, compounded): (1 + (expansion − revenue loss)/base)^12,
    //   base 8,187,394. Compounded the SAME way as GRR so both headline figures
    //   sit on one "projected yearly" basis and match the CSM dashboard exactly.
    // Inputs come from the same embedded snapshot (D.expansion, D.revenue_loss).
    const GRR_BASE = 7732095;
    const NRR_BASE = 8187394;
    const EXP = Object.assign({ arr: 0 }, D.expansion || {});
    const RL = Object.assign(
      { d2dStudio: 0, d2dVini: 0, partnerStudio: 0, partnerVini: 0 },
      D.revenue_loss || {}
    );
    const loss = (Number(RL.d2dStudio) || 0) + (Number(RL.d2dVini) || 0)
               + (Number(RL.partnerStudio) || 0) + (Number(RL.partnerVini) || 0);
    const exp = Number(EXP.arr) || 0;
    const grrPct = GRR_BASE > 0 ? Math.max(0, Math.pow(1 - loss / GRR_BASE, 12) * 100) : null;
    const nrrPct = NRR_BASE > 0 ? Math.pow(1 + (exp - loss) / NRR_BASE, 12) * 100 : null;

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      studio,
      salesIB, salesOB, serviceIB, serviceOB, viniOther: other,
      company: {
        grr: grrPct,           // Projected GRR (Yearly), %
        nrr: nrrPct,           // NRR, %
        grrBase: GRR_BASE, nrrBase: NRR_BASE, expansion: exp, revenueLoss: loss,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
