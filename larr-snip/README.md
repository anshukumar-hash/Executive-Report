# Daily Studio Report snip → Slack

Posts the **Studio Daily Report** table (gid `68024667`) into Slack as an image
every day at ~06:00 IST. It replaced the old Target Summary layout
(gid `939349578`, `A1:H42`) on 2026-10-14.

Run by [`.github/workflows/larr-daily-snip.yml`](../.github/workflows/larr-daily-snip.yml).
Unrelated to the Executive Report app — it lives here only because the Slack bot
token is already a secret in this repo.

## How it works

Rather than re-rendering the table in HTML (which means re-implementing the
conditional formatting and letting it drift), the script asks Google Sheets to
export the range as a PDF. Google applies the real cell formatting, so the snip
always matches what people see in the tab — the banded section headers, the
conditional greens and ambers, the blue MTD figures and red churn included.

1. `GET /export?format=pdf&range=B2:H19&scale=4` on the sheet.
2. `pdftoppm` renders page 1 at 200 dpi.
3. Pillow trims the page margins to the table's bounding box.
4. The post is dated from the sheet's own **Report date** cell — see below.
5. Slack `files.getUploadURLExternal` → upload → `files.completeUploadExternal`.

## Config

| Name | Where | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | repo secret | shared with the Executive Report job |
| `SLACK_CHANNEL` | repo secret | mapped to `SLACK_CHANNEL_ID` in the workflow |
| `SHEET_ID` / `SHEET_GID` / `RANGE` | defaults in `report.sh` | override via env |
| `REPORT_TITLE` | default in `report.sh` | `Studio Daily Report` |

`SHEET_GID`, not `GID`: zsh treats `GID` as a special parameter, so
`GID=123 ./report.sh` dies with *"failed to change group ID"* before the script
starts. `GID` is still read as a fallback for an existing caller.

The sheet must stay **link-readable**; the script has no Google credentials. If
sharing is tightened to invite-only, Google returns a sign-in page instead of a
PDF and the run fails loudly rather than posting a broken image.

## The Slack app

Posts go out as **Spyne_Studio_Bot** (manage it at api.slack.com/apps). The same
app backs the onboarding (OB) report in `saurabhshah-svg/onboarding_dashboard`
and the paused `exec-slack.yml` here, so renaming or re-scoping it affects all
three — and Slack relabels past messages with the app's current name, not the
one it had when they were posted.

App id **A0BJCRNNPJB**, bot user `U0BJW4XDY3T`, bot id `B0BJS7K0RL6`.

The name shown on each post comes from **App Home → Display Name (Bot Name)**,
not from the App name on the Basic Information page — and a change to it only
reaches the workspace after **Settings → Install App → Reinstall to Workspace**.
Reinstalling without touching scopes keeps the existing token; adding a scope
issues a new one and `SLACK_BOT_TOKEN` must be updated with it.

**Do not use `--whoami` to check the name.** `auth.test` returns the bot's
*handle* (`user` = `executivereportbot`), which Slack never renamed and never
will — it is a different field from the display name and is permanently stale.
Reading the real display name needs `users:read`, which this token lacks. The
rename was verified from the Slack app profile instead, and that is the only
free way to confirm it. Treating that stale handle as evidence cost several
rounds of chasing the wrong app.

## Changing the range

`RANGE` defaults to `B2:H19` — the title block through the last Customer-success
row. Column A is empty padding in this tab, so the range starts at B. If rows are
added below row 19, widen it or the bottom of the table gets cut off.

## The report date

The team works the **US shift**, so the 06:00 IST post carries the *previous*
day's numbers. The title is read from the sheet's own "Report date" cell rather
than computed from the clock, so it can never disagree with the image beneath
it. If that cell cannot be parsed the script falls back to yesterday and logs a
`WARN`. Do not replace this with `date` — a 13 Oct report titled 14 Oct is the
bug it was written to fix.

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
