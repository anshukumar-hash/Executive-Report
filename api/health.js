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

const roiMtdRag = v =>
  (v == null || v === 0 || isNaN(v)) ? 'NA' : v >= 4 ? 'Green' : v >= 2 ? 'Amber' : 'Red';

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

    // ── VINI agents (port of viniAggregateRooftops, health-relevant fields) ──
    const V_COL = {}; (D.v_schema || []).forEach((k, i) => V_COL[k] = i);
    const VINI_STAGE = Array.isArray(D.vini_stage) ? D.vini_stage
      : (D.vini_stage && Array.isArray(D.vini_stage.value) ? D.vini_stage.value : []);
    const byKey = {};
    for (const s of VINI_STAGE) {
      if (!s.rid) continue;
      const key = s.rid + '|' + (s.agent || '');
      if (byKey[key]) {
        const e = byKey[key];
        e.mrr += Number(s.mrr) || 0;
        e.arr += Number(s.arr) || 0;
        if (s.stage === 'Churned') e.stage = 'Churned';
        continue;
      }
      byKey[key] = {
        rid: s.rid, eid: s.eid, en: s.en, agent: s.agent || '', stage: s.stage || '',
        mrr: Number(s.mrr) || 0, arr: Number(s.arr) || 0, ps: s.ps,
        apptValue_mtd: 0,
      };
    }
    for (const r of (D.v_rows || [])) {
      const day = r[V_COL.day];
      if (!day || day < range.from || day > range.to) continue;
      const a = byKey[r[V_COL.rid] + '|' + (r[V_COL.agent] || '')];
      if (!a) continue;
      a.apptValue_mtd += (Number(r[V_COL.a]) || 0) * apptValuePerAppt(a.agent);
    }
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const mtdFactor = today.getDate() / daysInMonth;

    const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    const yKey = ymd(yest);
    const reportRag = rid => {
      const st = (reportTracking[rid] || {})[yKey];
      return !st ? 'NA' : (st === 'sent' ? 'Green' : 'Red');
    };

    const mkBucket = () => ({ green: 0, amber: 0, red: 0, na: 0, agents: 0, totalArr: 0,
                              arr: { green: 0, amber: 0, red: 0 } });
    const sales = mkBucket(), service = mkBucket(), other = mkBucket();
    for (const a of Object.values(byKey)) {
      if (String(a.stage || '').toLowerCase() === 'churned') continue;
      const roiMtd = (a.mrr * mtdFactor) > 0 ? a.apptValue_mtd / (a.mrr * mtdFactor) : 0;
      const g = blend({
        usage: roiMtdRag(roiMtd),
        payment: a.ps,
        comm: csatRag(a.eid, a.en),
        ticket: enterpriseTicketRag(a.eid, VINI_TIX, range),
        reportSent: reportRag(a.rid),
      }, { usage: 3, payment: 3, comm: 2, ticket: 2, reportSent: 2 });
      const b = /sales/i.test(a.agent) ? sales : /service/i.test(a.agent) ? service : other;
      b.agents++; b.totalArr += a.arr;
      if (g === 'Green') { b.green++; b.arr.green += a.arr; }
      else if (g === 'Amber') { b.amber++; b.arr.amber += a.arr; }
      else if (g === 'Red') { b.red++; b.arr.red += a.arr; }
      else b.na++;
    }

    // ── Company GRR & NRR (ported from the CSM dashboard, overall scope) ──
    // GRR (Projected Yearly, compounded): (1 − churn/base)^12, base fixed at
    //   7,732,095 for the unfiltered overall headline.
    // NRR = (base + expansion − revenue loss) / base, base 8,187,394.
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
    const nrrPct = NRR_BASE > 0 ? (NRR_BASE + exp - loss) / NRR_BASE * 100 : null;

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      studio, viniSales: sales, viniService: service, viniOther: other,
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
