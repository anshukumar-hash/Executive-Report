// Daily Spyne Executive Report — inline-HTML email (no screenshot/attachment).
// Fetches the live API endpoints from the deployed dashboard, builds an
// email-client-safe (table-based, inline-styled) HTML body, and sends it via
// Workspace/Gmail SMTP.
//
// Env:
//   GMAIL_USER          — sending address (e.g. reports@spyne.ai)
//   GMAIL_APP_PASSWORD  — Google app password for that account
//   DIGEST_RECIPIENTS   — optional; defaults to saurabh.shah@spyne.ai
//   BASE_URL            — optional; defaults to the deployed dashboard
import nodemailer from 'nodemailer';

const BASE = process.env.BASE_URL || 'https://exec-report-repo.vercel.app';
const TO = (process.env.DIGEST_RECIPIENTS || 'saurabh.shah@spyne.ai')
  .split(/[,\s]+/).filter(Boolean);
const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
if (!user || !pass) { console.error('Missing GMAIL_USER / GMAIL_APP_PASSWORD'); process.exit(1); }

async function getJSON(path) {
  const r = await fetch(BASE + path, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
  return r.json();
}

// ─── formatting ──────────────────────────────────────────────────────────────
const fm = v => '$' + (v / 1e6).toFixed(2) + 'M';
const fk = v => '$' + (v / 1000).toFixed(1) + 'K';
const fbig = v => v >= 1e6 ? fm(v) : fk(v);

// ─── palette / fonts ─────────────────────────────────────────────────────────
const INK='#211A15', IVORY='#F6F1E8', IVORY50='#FBF8F3', WINE='#7A2E45', GOLD='#C6A86B',
      TAUPE='#A89A8C', MUT='#8A7D6F', GREEN='#5C7A52', AMBER='#B8862F', RED='#A33B36';
// Single professional sans throughout — consistent baselines, clean for leadership.
const serif="'Helvetica Neue', Helvetica, Arial, sans-serif", sans="'Helvetica Neue', Helvetica, Arial, sans-serif";
// Row tints — distinct from the ivory page and from each other.
const STUDIO_BG='#E4EDF6', SALES_BG='#F1E6D0', SVC_BG='#E2EDE3';

const kpi = (label, val, c=IVORY50) => `<td width="25%" valign="top" style="padding:0 10px; border-left:1px solid rgba(214,189,134,0.28);">
  <div style="font-family:${sans}; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:${TAUPE}; font-weight:bold;">${label}</div>
  <div style="font-family:${serif}; font-size:34px; font-weight:bold; color:${c}; padding-top:8px;">${val}</div></td>`;

// Monthly GM% (Jan→Jun) for the Finance trend.
const STUDIO_GM = [79.65,76.69,76.21,74.90,76.82,74.32];
const VINI_GM   = [3.09,22.02,63.82,38.38,44.82,33.16];
// Email-safe mini bar chart (SVG is stripped by Gmail/Outlook; table bars render everywhere).
const sparkbars = (vals, color) => {
  const H = 40;
  const bars = vals.map(v => {
    const bh = Math.max(2, Math.round(v / 100 * H));
    return `<td width="15" valign="bottom" style="padding:0 2px; height:${H}px;"><table cellpadding="0" cellspacing="0" width="100%"><tr><td height="${bh}" style="background:${color}; border-radius:2px 2px 0 0; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>`;
  }).join('');
  return `<table cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>${bars}</tr></table>`;
};
const finCell = (label, val, vals, color, border=false) => `<td width="50%" valign="top" style="padding:0 14px;${border?'border-left:1px solid #E9E1D4;':''}">
  <div style="font-family:${serif}; font-size:24px; color:${INK};">${val}</div>
  <div style="font-family:${sans}; font-size:12px; color:${MUT}; padding-top:5px;">${label}</div>
  ${sparkbars(vals, color)}</td>`;

const metric = (label, val, sub='', c=INK, border=false) => `<td width="33%" valign="top" style="padding:0 14px;${border?'border-left:1px solid #E9E1D4;':''}">
  <div style="font-family:${serif}; font-size:24px; color:${c};">${val}</div>
  <div style="font-family:${sans}; font-size:12px; color:${MUT}; padding-top:5px;">${label}</div>
  ${sub?`<div style="font-family:${sans}; font-size:10px; color:${MUT}; padding-top:3px; white-space:nowrap;">${sub}</div>`:''}</td>`;

const deptrow = (title, sub, cells, bg='#ffffff') => `<tr><td style="padding:0 0 10px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg}; border-radius:12px;"><tr>
    <td width="150" valign="middle" style="padding:14px 16px;">
      <div style="font-family:${sans}; font-size:14px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; color:${WINE};">${title}</div>
      <div style="font-family:${sans}; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:${MUT}; padding-top:4px;">${sub}</div></td>
    <td valign="middle" style="padding:14px 10px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td>
  </tr></table></td></tr>`;

const tile = (count, label, arr, color, bg) => `<td width="33%" valign="top" style="padding:0 6px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg}; border-radius:10px;"><tr><td style="padding:15px 18px;">
    <div style="font-family:${serif}; font-size:32px; font-weight:bold; color:${color};">${count}</div>
    <div style="font-family:${sans}; font-size:12px; color:${MUT}; padding-top:4px;">${label}</div>
    <div style="font-family:${sans}; font-size:14px; font-weight:bold; color:${INK}; padding-top:3px;">${arr}</div>
  </td></tr></table></td>`;

const healthCells = b => tile(b.green,'Green',fbig(b.arr.green),GREEN,'#F4F7F2')
  + tile(b.amber,'Amber',fbig(b.arr.amber),AMBER,'#FBF7EF')
  + tile(b.red,'Red',fbig(b.arr.red),RED,'#FBF1F0');

function buildHTML(m, h, delivery, support) {
  const img = delivery.imagePendency != null ? String(delivery.imagePendency) : '—';
  const video = delivery.videoPendency != null ? String(delivery.videoPendency) : '—';
  const three = delivery.threeSixtyPendency != null ? String(delivery.threeSixtyPendency) : '—';
  const pt = support.pendingTickets || { vini: '—', studio: '—' };
  const cs = m.csChurn, pl = m.projectedNewLive;

  let rows = '';
  rows += deptrow('Sales','Growth', metric('New Sales MTD',fbig(m.newSales.arr))+metric('Sent to OB',fbig(m.newOb.total),'',INK,true)+metric('PWS',fbig(m.pws.total),'',INK,true));
  rows += deptrow('Onboarding','Growth', metric('New Live MTD',fbig(m.newLive.total))+metric('Gap to Target',fbig(pl.gap),`Achieved ${fbig(pl.achieved)} / ${fm(pl.target)}`,RED,true)+metric('ARR in Ob',fbig(m.arrInOb.total),'',INK,true));
  rows += deptrow('Customer Success','Churned / Contracted', metric('Accounts',String(cs.logos),`Studio ${cs.studio.logos} · Vini ${cs.vini.logos}`)+metric('Revenue',fbig(cs.totalARR),`Studio ${fbig(cs.studio.arr)} · Vini ${fbig(cs.vini.arr)}`,RED,true)+'<td width="33%"></td>');
  rows += deptrow('Support','Operations', metric('Pending Tickets · Vini',String(pt.vini))+metric('Pending Tickets · Studio',String(pt.studio),'',INK,true)+'<td width="33%"></td>');
  rows += deptrow('Delivery','Operations', metric('Pendency · Image',img)+metric('Pendency · Video',video,'',INK,true)+metric('Pendency · 360',three,'',INK,true));
  rows += deptrow('Studio Product','Product · Rooftops', healthCells(h.studio), STUDIO_BG);
  rows += deptrow('Sales IB','Vini · Agents · ARR', healthCells(h.salesIB), SALES_BG);
  rows += deptrow('Sales OB','Vini · Agents · ARR', healthCells(h.salesOB), SALES_BG);
  rows += deptrow('Service IB','Vini · Agents · ARR', healthCells(h.serviceIB), SVC_BG);
  rows += deptrow('Service OB','Vini · Agents · ARR', healthCells(h.serviceOB), SVC_BG);
  rows += deptrow('Finance','Finance', finCell('GM · Tech (Studio) · Jan→Jun','74.32%',STUDIO_GM,GREEN)+finCell('GM · Tech (Vini) · Jan→Jun','33.16%',VINI_GM,WINE,true));

  const today = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0; padding:0; background:${IVORY};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${IVORY};"><tr><td align="center" style="padding:20px 12px;">
<table width="640" cellpadding="0" cellspacing="0" style="width:640px; max-width:640px;">
  <tr><td style="padding:6px 6px 16px 6px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td valign="middle"><span style="font-family:${sans}; font-weight:bold; font-size:22px; letter-spacing:5px; color:${INK};">SPYNE</span>
      <span style="font-family:${serif}; font-size:20px; color:${INK}; padding-left:10px;">&nbsp;|&nbsp; Executive Report</span></td>
    <td align="right" valign="middle" style="font-family:${serif}; font-size:18px; color:${INK};">${today}</td>
  </tr></table></td></tr>
  <tr><td style="padding:0 0 14px 0;"><table width="100%" cellpadding="0" cellspacing="0" style="background:${INK}; border-radius:16px;"><tr><td style="padding:22px 20px;">
    <div style="font-family:${sans}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${GOLD}; font-weight:bold; padding-bottom:14px;">Company Headline &nbsp;·&nbsp; ARR in USD</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${kpi('LARR',fm(m.larr.total))}${kpi('CARR',fm(m.carr.total))}${kpi('GRR',h.company.grr.toFixed(1)+'%')}${kpi('NRR',h.company.nrr.toFixed(1)+'%')}</tr></table>
  </td></tr></table></td></tr>
  ${rows}
  <tr><td style="padding:10px 6px; font-family:${sans}; font-size:11px; color:${MUT}; text-align:center;">
    Live figures as of ${today} · Confidential — Board &amp; Leadership · <a href="${BASE}" style="color:${WINE};">Open live dashboard</a></td></tr>
</table></td></tr></table></body></html>`;
}

// ─── run ─────────────────────────────────────────────────────────────────────
const [m, h, delivery, support] = await Promise.all([
  getJSON('/api/metrics'), getJSON('/api/health'),
  getJSON('/api/delivery').catch(() => ({})), getJSON('/api/support').catch(() => ({})),
]);
const html = buildHTML(m, h, delivery, support);
const today = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

// Build-only: WRITE_HTML=<path> dumps the email HTML and exits (no send).
if (process.env.WRITE_HTML) {
  const { writeFileSync } = await import('fs');
  writeFileSync(process.env.WRITE_HTML, html);
  console.log('Wrote', process.env.WRITE_HTML, '(', html.length, 'bytes ) — no email sent');
  process.exit(0);
}

const tx = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: { user, pass },
});
const info = await tx.sendMail({
  from: user, to: TO,
  subject: `Spyne Executive Report — ${today}`,
  text: `Spyne Executive Report for ${today}. View the live dashboard: ${BASE}`,
  html,
});
console.log('Sent exec report to', TO.join(', '), '— id', info.messageId);
