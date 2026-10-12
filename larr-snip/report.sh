#!/bin/bash
# Daily LARR / Target Summary snip -> Slack.
#
# Exports the sheet range as PDF (Google renders the real conditional formatting,
# so the snip always matches what people see in the tab), converts page 1 to PNG,
# trims the page margins, and uploads it to Slack.
#
# Config lives in .env next to this script: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID.
# Scheduled by cron at 18:00 IST — see install-cron.sh.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cron hands over a near-empty PATH; Homebrew dirs are harmless on CI runners.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# On CI, log straight to the job output. Locally, keep a rolling file.
if [ -z "${CI:-}" ]; then
  mkdir -p "$HERE/logs"
  exec >> "$HERE/logs/report.log" 2>&1
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') run start ==="

# shellcheck disable=SC1091
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

SHEET_ID="${SHEET_ID:-1kE98qnPZ3JC1Q96EMXxOoLuVszb7dJRyPOOIshZ6tpA}"
GID="${GID:-939349578}"
RANGE="${RANGE:-A1:H42}"
SHEET_URL="https://docs.google.com/spreadsheets/d/$SHEET_ID/edit?gid=$GID"

die() { echo "ERROR: $*"; exit 1; }

# --dry-run builds the image into ./preview.png and skips Slack entirely.
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --whoami reports which Slack app the token actually belongs to. Posts nothing.
# Use it when the name on the posts is not the app you think you renamed.
if [ "${1:-}" = "--whoami" ]; then
  [ -n "${SLACK_BOT_TOKEN:-}" ] || die "SLACK_BOT_TOKEN not set"
  WHO=$(curl -s --max-time 30 -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
          https://slack.com/api/auth.test)
  echo "$WHO" | grep -q '"ok":true' || die "auth.test failed: $WHO"
  echo "$WHO" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for k in ("team", "user", "user_id", "bot_id", "url"):
    print(f"  {k:8} = {d.get(k)}")
'
  UID=$(echo "$WHO" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user_id",""))')
  # users.info needs users:read; it is only extra detail, so tolerate failure.
  INFO=$(curl -s --max-time 30 -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
           "https://slack.com/api/users.info?user=$UID")
  if echo "$INFO" | grep -q '"ok":true'; then
    echo "$INFO" | python3 -c '
import sys, json
p = json.load(sys.stdin)["user"]
prof = p.get("profile", {})
app = prof.get("api_app_id") or p.get("api_app_id")
disp = prof.get("display_name") or "(unset - Slack falls back to real name)"
print("  app_id   = %s" % app)
print("  realname = %s" % prof.get("real_name"))
print("  display  = %s" % disp)
'
  else
    echo "  (users.info unavailable: $(echo "$INFO" | head -c 120))"
  fi
  echo "=== whoami ok ==="
  exit 0
fi

if [ "$DRY_RUN" = "0" ]; then
  [ -n "${SLACK_BOT_TOKEN:-}" ] || die "SLACK_BOT_TOKEN not set (put it in $HERE/.env)"
  [ -n "${SLACK_CHANNEL_ID:-}" ] || die "SLACK_CHANNEL_ID not set (put it in $HERE/.env)"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. export the range as PDF -------------------------------------------
EXPORT_URL="https://docs.google.com/spreadsheets/d/$SHEET_ID/export?format=pdf&gid=$GID&range=$RANGE&portrait=true&scale=4&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&attachment=false&top_margin=0.15&bottom_margin=0.15&left_margin=0.15&right_margin=0.15"

HTTP=$(curl -sL --max-time 90 -o "$WORK/snip.pdf" -w '%{http_code}' "$EXPORT_URL") \
  || die "curl failed fetching the sheet export"
[ "$HTTP" = "200" ] || die "sheet export returned HTTP $HTTP (is the sheet still link-readable?)"
head -c 4 "$WORK/snip.pdf" | grep -q '%PDF' \
  || die "export was not a PDF — Google likely returned a sign-in page; check sheet sharing"

# --- 2. page 1 -> PNG, trimmed --------------------------------------------
# Page 2 is only a footnote sliver, so -f 1 -l 1 keeps the table alone.
pdftoppm -png -r 200 -f 1 -l 1 -singlefile "$WORK/snip.pdf" "$WORK/snip" \
  || die "pdftoppm failed (brew install poppler)"
[ -s "$WORK/snip.png" ] || die "pdftoppm produced no image"

python3 - "$WORK/snip.png" <<'PY' || echo "WARN: trim skipped (Pillow unavailable) — posting untrimmed"
import sys
from PIL import Image, ImageChops

path = sys.argv[1]
im = Image.open(path).convert("RGB")
bg = Image.new("RGB", im.size, (255, 255, 255))
bbox = ImageChops.difference(im, bg).getbbox()
if bbox:
    pad = 16
    l, t, r, b = bbox
    box = (max(l - pad, 0), max(t - pad, 0),
           min(r + pad, im.width), min(b + pad, im.height))
    im.crop(box).save(path)
PY

SIZE=$(wc -c < "$WORK/snip.png" | tr -d ' ')
echo "image ready: $SIZE bytes"

if [ "$DRY_RUN" = "1" ]; then
  cp "$WORK/snip.png" "$HERE/preview.png"
  echo "dry run — wrote $HERE/preview.png, nothing posted to Slack"
  echo "=== run ok (dry) ==="
  exit 0
fi

# --- 3. upload to Slack ----------------------------------------------------
TODAY=$(date '+%d %b %Y')
FILENAME="larr-target-summary-$(date '+%Y-%m-%d').png"

UP=$(curl -s --max-time 60 -X POST https://slack.com/api/files.getUploadURLExternal \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  --data-urlencode "filename=$FILENAME" \
  --data-urlencode "length=$SIZE")
echo "$UP" | grep -q '"ok":true' || die "files.getUploadURLExternal failed: $UP"

UPLOAD_URL=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload_url"])')
FILE_ID=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["file_id"])')

curl -s --max-time 120 -f -F "file=@$WORK/snip.png" "$UPLOAD_URL" > /dev/null \
  || die "uploading the image bytes to Slack failed"

COMMENT=":bar_chart: *Target Summary — $TODAY*
<$SHEET_URL|Open the sheet>"

PAYLOAD=$(FILE_ID="$FILE_ID" CH="$SLACK_CHANNEL_ID" TITLE="Target Summary — $TODAY" CMT="$COMMENT" python3 -c '
import json, os
print(json.dumps({
    "files": [{"id": os.environ["FILE_ID"], "title": os.environ["TITLE"]}],
    "channel_id": os.environ["CH"],
    "initial_comment": os.environ["CMT"],
}))')

DONE=$(curl -s --max-time 60 -X POST https://slack.com/api/files.completeUploadExternal \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "$PAYLOAD")
echo "$DONE" | grep -q '"ok":true' || die "files.completeUploadExternal failed: $DONE"

echo "posted to Slack channel $SLACK_CHANNEL_ID"
echo "=== run ok ==="
