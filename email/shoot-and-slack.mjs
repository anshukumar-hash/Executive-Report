// Daily Spyne Executive Report — screenshot → Slack channel.
// Loads the deployed dashboard (live /api data fills the page), screenshots the
// #report-root card for EACH product view (Overall, Studio, Vini), and posts the
// three PNGs together to Slack via the Web API files-v2 flow.
//
// Env (GitHub Actions secrets):
//   SLACK_BOT_TOKEN — Slack bot token (xoxb-…) with files:write + chat:write
//   SLACK_CHANNEL   — target channel ID (e.g. C0123ABCD); bot must be in it
//   SLACK_COMMENT   — optional message text above the images
//   BASE_URL        — optional; defaults to the live AWS dashboard
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

// Capture the live AWS deployment (auto-refreshes on every push to main via
// aws-promote → CodePipeline). Set BASE_URL to override (e.g. the Vercel copy).
const BASE = process.env.BASE_URL || 'https://executive-report.spyne.ai';
const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL;
if (!token || !channel) { console.log('SLACK_BOT_TOKEN / SLACK_CHANNEL not set — skipping (no-op).'); process.exit(0); }

// ── Hard approval gate ───────────────────────────────────────────────────────
// The report must NEVER be sent without the user's explicit permission. The only
// thing that counts as permission is a manual run that sets FORCE_SEND=1 (wired
// to the workflow_dispatch "force" input). Every scheduled/automatic run reaches
// here with FORCE_SEND unset and no-ops. This is independent of the workflow's
// enabled/disabled state — so even if a schedule is ever re-enabled by accident,
// nothing is posted to Slack until a human explicitly approves that run.
const FORCE = process.env.FORCE_SEND === '1' || process.env.FORCE_SEND === 'true';
if (!FORCE) {
  console.log('NOT SENT: no explicit approval (FORCE_SEND!=1). Run the workflow manually with force=true to send.');
  process.exit(0);
}

// ── Regression guard ─────────────────────────────────────────────────────────
// Hold the report (and ask for approval) when BOTH New Sales MTD and New Live
// MTD fell vs the LAST sent report, within the same month. Both are MTD
// cumulative — they only rise inside a month — so a simultaneous drop signals a
// data problem, not real movement. A month rollover legitimately resets both to
// ~0, so the check only fires when prev and today are the same month. Bypass
// with FORCE_SEND=1 (manual approval via the workflow's "force" input).
const STATE_FILE = new URL('./last-report-state.json', import.meta.url);

let todayNewSales = null, todayNewLive = null, curMonth = null;
try {
  const mx = await (await fetch(`${BASE}/api/metrics?_=${Date.now()}`)).json();
  todayNewSales = Number(mx?.newSales?.total ?? mx?.newSales?.arr);
  todayNewLive  = Number(mx?.newLive?.total);
  curMonth = mx?.month || null;
} catch (e) { console.log('guard: could not read /api/metrics —', e.message); }

let prev = null;
try { prev = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}

const bothDown = prev && prev.month === curMonth
  && Number.isFinite(todayNewSales) && Number.isFinite(todayNewLive)
  && todayNewSales < prev.newSales && todayNewLive < prev.newLive;

if (bothDown && !FORCE) {
  const fmt = (n) => '$' + Math.round(n).toLocaleString();
  const text =
    ':warning: *Executive Report held for review — NOT sent.*\n'
    + `Both headline MTD figures fell vs the last report (${prev.date}):\n`
    + `• New Sales MTD: ${fmt(prev.newSales)} → ${fmt(todayNewSales)}\n`
    + `• New Live MTD: ${fmt(prev.newLive)} → ${fmt(todayNewLive)}\n`
    + 'MTD figures only rise within a month, so this looks like a data issue. '
    + 'Review, then re-run the workflow with *force* to send.';
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text }),
  });
  console.log('HELD: New Sales and New Live both down vs last report — alerted, not sent.');
  process.exit(0);
}


// The three views to capture, in tab order. `tab` matches the dashboard's
// setTab() argument; `label` is the human name used in the Slack file titles.
const VIEWS = [
  { tab: 'overall', label: 'Overall' },
  { tab: 'studio',  label: 'Studio'  },
  { tab: 'vini',    label: 'Vini'    },
];

// 1) Render the deployed dashboard once, then screenshot each tab.
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const shots = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('#report-root', { timeout: 30000 });
  // Let the live /api/metrics + /api/health + delivery/support calls populate.
  await page.waitForTimeout(18000);

  for (const view of VIEWS) {
    // Switch the tab in-page (re-renders from the already-loaded data), then hide
    // the Copy Snapshot button and the Overall/Studio/Vini tab bar so neither is
    // captured — each screenshot is a clean single-view report card.
    await page.evaluate((tab) => {
      if (typeof window.setTab === 'function') window.setTab(tab);
      ['copyBtn', 'tabbar'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    }, view.tab);
    await page.waitForTimeout(800); // let the re-render settle
    const el = await page.$('#report-root');
    const png = await el.screenshot({ type: 'png' });
    shots.push({ ...view, png });
  }
} finally {
  await browser.close();
}

// 2) Upload each PNG to Slack (files upload v2 flow), collecting file ids.
const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const datePart = today.replace(/ /g, '-');
const files = [];
for (const shot of shots) {
  const filename = `spyne-exec-report-${shot.label.toLowerCase()}-${datePart}.png`;
  const r1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename, length: String(shot.png.length) }),
  });
  const j1 = await r1.json();
  if (!j1.ok) throw new Error('getUploadURLExternal failed: ' + j1.error);

  const fd = new FormData();
  fd.append('file', new Blob([shot.png], { type: 'image/png' }), filename);
  const r2 = await fetch(j1.upload_url, { method: 'POST', body: fd });
  if (!r2.ok) throw new Error('file upload POST failed: HTTP ' + r2.status);

  files.push({ id: j1.file_id, title: `Spyne Executive Report — ${shot.label} — ${today}` });
}

// 3) Complete the upload with all three files in a single Slack message.
const comment = process.env.SLACK_COMMENT || `:bar_chart: *Spyne Executive Report — ${today}*  ·  Overall · Studio · Vini  ·  <${BASE}|Open live dashboard>`;
// Sender name comes from the Slack app itself (create it as "Executive_Report_Bot").
const r3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ files, channel_id: channel, initial_comment: comment }),
});
const j3 = await r3.json();
if (!j3.ok) throw new Error('completeUploadExternal failed: ' + j3.error);
console.log(`Posted ${files.length} exec report screenshots (Overall/Studio/Vini) to Slack channel ${channel}.`);

// Record this send's headline figures so the next run can compare.
try {
  writeFileSync(STATE_FILE, JSON.stringify({ date: today, month: curMonth, newSales: todayNewSales, newLive: todayNewLive }, null, 2));
  console.log('state updated:', curMonth, todayNewSales, todayNewLive);
} catch (e) { console.log('could not write report state:', e.message); }
