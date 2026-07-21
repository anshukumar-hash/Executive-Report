// Daily Spyne Executive Report — screenshot → Slack channel.
// Loads the deployed dashboard (live /api data fills the page), screenshots the
// #report-root card, and posts the PNG to Slack via the Web API files-v2 flow.
//
// Env (GitHub Actions secrets):
//   SLACK_BOT_TOKEN — Slack bot token (xoxb-…) with files:write + chat:write
//   SLACK_CHANNEL   — target channel ID (e.g. C0123ABCD); bot must be in it
//   SLACK_COMMENT   — optional message text above the image
//   BASE_URL        — optional; defaults to the deployed dashboard
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://exec-report-repo.vercel.app';
const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL;
if (!token || !channel) { console.log('SLACK_BOT_TOKEN / SLACK_CHANNEL not set — skipping (no-op).'); process.exit(0); }

// 1) Render the deployed dashboard and screenshot the report card.
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let png;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('#report-root', { timeout: 30000 });
  // Let the live /api/metrics + /api/health + delivery/support calls populate.
  await page.waitForTimeout(18000);
  // Hide the floating Copy Snapshot button so it isn't captured in the corner.
  await page.evaluate(() => { const b = document.getElementById('copyBtn'); if (b) b.style.display = 'none'; });
  const el = await page.$('#report-root');
  png = await el.screenshot({ type: 'png' });
} finally {
  await browser.close();
}

// 2) Upload to Slack (files upload v2 flow).
const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const filename = `spyne-exec-report-${today.replace(/ /g, '-')}.png`;
const comment = process.env.SLACK_COMMENT || `:bar_chart: *Spyne Executive Report — ${today}*  ·  <${BASE}|Open live dashboard>`;

const r1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ filename, length: String(png.length) }),
});
const j1 = await r1.json();
if (!j1.ok) throw new Error('getUploadURLExternal failed: ' + j1.error);

const fd = new FormData();
fd.append('file', new Blob([png], { type: 'image/png' }), filename);
const r2 = await fetch(j1.upload_url, { method: 'POST', body: fd });
if (!r2.ok) throw new Error('file upload POST failed: HTTP ' + r2.status);

const r3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    files: [{ id: j1.file_id, title: `Spyne Executive Report — ${today}` }],
    channel_id: channel,
    initial_comment: comment,
  }),
});
const j3 = await r3.json();
if (!j3.ok) throw new Error('completeUploadExternal failed: ' + j3.error);
console.log(`Posted exec report screenshot to Slack channel ${channel}.`);
