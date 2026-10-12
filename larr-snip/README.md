# Daily LARR Target Summary snip → Slack

Posts the **Target Summary** table from the Studio Oct Funnel sheet into Slack as an
image every day at ~06:00 IST.

Run by [`.github/workflows/larr-daily-snip.yml`](../.github/workflows/larr-daily-snip.yml).
Unrelated to the Executive Report app — it lives here only because the Slack bot
token is already a secret in this repo.

## How it works

Rather than re-rendering the table in HTML (which means re-implementing the
conditional formatting and letting it drift), the script asks Google Sheets to
export the range as a PDF. Google applies the real cell formatting, so the snip
always matches what people see in the tab — greens, reds, the boxed MTD cells
and the yellow Grand Total block included.

1. `GET /export?format=pdf&range=A1:H42&scale=4` on the sheet.
2. `pdftoppm` renders page 1 at 200 dpi. (Page 2 is only a footnote sliver.)
3. Pillow trims the page margins to the table's bounding box.
4. Slack `files.getUploadURLExternal` → upload → `files.completeUploadExternal`.

## Config

| Name | Where | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | repo secret | shared with the Executive Report job |
| `SLACK_CHANNEL` | repo secret | mapped to `SLACK_CHANNEL_ID` in the workflow |
| `SHEET_ID` / `GID` / `RANGE` | defaults in `report.sh` | override via env |

The sheet must stay **link-readable**; the script has no Google credentials. If
sharing is tightened to invite-only, Google returns a sign-in page instead of a
PDF and the run fails loudly rather than posting a broken image.

## The Slack app

Posts go out as **Spyne_Studio_Bot** (manage it at api.slack.com/apps). The same
app backs the onboarding (OB) report in `saurabhshah-svg/onboarding_dashboard`
and the paused `exec-slack.yml` here, so renaming or re-scoping it affects all
three — and Slack relabels past messages with the app's current name, not the
one it had when they were posted.

The name shown on each post comes from **App Home → Display Name (Bot Name)**,
not from the App name on the Basic Information page.

## Changing the range

`RANGE` defaults to `A1:H42` — the table only. Rows 44+ are the MTD helper block
and footnotes, deliberately excluded. If rows are inserted above row 42, widen
the range or the bottom of the table gets cut off.

## Running it by hand

```bash
gh workflow run larr-daily-snip.yml -R anshukumar-hash/Executive-Report
```

Locally, to see the image without posting anything to Slack:

```bash
bash larr-snip/report.sh --dry-run   # writes larr-snip/preview.png
```

Needs `poppler` and Pillow: `brew install poppler && python3 -m pip install --user Pillow`.

## Scheduling

Three cron windows (06:00 / 06:20 / 06:40 IST) because GitHub's scheduler is
best-effort and often runs late. A gate checks whether a run already succeeded
today and skips the later windows, so exactly one snip goes out per day.
