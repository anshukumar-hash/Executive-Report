#!/bin/bash
# Daily LARR / Target Summary snip -> Slack.
#
# Exports the sheet range as PDF (Google renders the real conditional formatting,
# so the snip always matches what people see in the tab), converts page 1 to PNG,
# trims the page margins, and uploads it to Slack.
#
# Config lives in .env next to this script: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID.
# Scheduled at ~06:00 IST by .github/workflows/larr-daily-snip.yml.

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
# SHEET_GID, not GID: zsh treats GID as a special parameter, so `GID=123 ./report.sh`
# from an interactive shell tries to change the process group and dies with
# "failed to change group ID" before the script ever starts. GID is still read as
# a fallback so an existing caller keeps working.
SHEET_GID="${SHEET_GID:-${GID:-68024667}}"
RANGE="${RANGE:-B2:H19}"
REPORT_TITLE="${REPORT_TITLE:-Studio Daily Report}"
SHEET_URL="https://docs.google.com/spreadsheets/d/$SHEET_ID/edit?gid=$SHEET_GID"

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
  BOT_UID=$(echo "$WHO" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user_id",""))')
  # users.info needs users:read; it is only extra detail, so tolerate failure.
  INFO=$(curl -s --max-time 30 -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
           "https://slack.com/api/users.info?user=$BOT_UID")
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

# --delete-file F0123ABC removes one uploaded snip and the message carrying it.
# files.delete needs only files:write, which this token has. There is no preview
# step because listing/inspecting files needs files:read, which it does not have
# — so the id is taken on trust and the deletion is immediate and permanent.
if [ "${1:-}" = "--delete-file" ]; then
  FID="${2:-}"
  [ -n "${SLACK_BOT_TOKEN:-}" ] || die "SLACK_BOT_TOKEN not set"
  [ -n "$FID" ] || die "usage: report.sh --delete-file <file id, starts with F>"
  case "$FID" in
    F[A-Za-z0-9]*) : ;;
    *) die "'$FID' is not a Slack file id — expected something like F09ABCDEFGH" ;;
  esac
  echo "deleting file $FID"
  DEL=$(curl -s --max-time 30 -X POST https://slack.com/api/files.delete \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "file=$FID")
  echo "$DEL" | grep -q '"ok":true' || die "files.delete failed: $DEL"
  echo "deleted $FID (the message carrying it goes with it)"
  echo "=== delete ok ==="
  exit 0
fi

# --dm someone@company.com sends the report to that person's DM instead of the
# channel. It only resolves the destination and then falls through to the normal
# build-and-post path, so the DM and the channel post are the same image built
# the same way. Needs two scopes this app may not carry -- users:read.email to
# turn an address into a user id, im:write to open the DM -- and Slack names the
# missing one, so a failure here says exactly what to add.
if [ "${1:-}" = "--dm" ]; then
  DM_EMAIL="${2:-}"
  [ -n "${SLACK_BOT_TOKEN:-}" ] || die "SLACK_BOT_TOKEN not set"
  [ -n "$DM_EMAIL" ] || die "usage: report.sh --dm <email>"
  LU=$(curl -s --max-time 30 -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        --data-urlencode "email=$DM_EMAIL" https://slack.com/api/users.lookupByEmail)
  echo "$LU" | grep -q '"ok":true' || die "users.lookupByEmail failed: $LU"
  DM_UID=$(echo "$LU" | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["id"])')
  OPEN=$(curl -s --max-time 30 -X POST https://slack.com/api/conversations.open \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "users=$DM_UID")
  echo "$OPEN" | grep -q '"ok":true' || die "conversations.open failed: $OPEN"
  SLACK_CHANNEL_ID=$(echo "$OPEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["channel"]["id"])')
  echo "resolved $DM_EMAIL -> user $DM_UID, dm channel $SLACK_CHANNEL_ID"
fi

if [ "$DRY_RUN" = "0" ]; then
  [ -n "${SLACK_BOT_TOKEN:-}" ] || die "SLACK_BOT_TOKEN not set (put it in $HERE/.env)"
  [ -n "${SLACK_CHANNEL_ID:-}" ] || die "SLACK_CHANNEL_ID not set (put it in $HERE/.env)"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. export the range as PDF -------------------------------------------
EXPORT_URL="https://docs.google.com/spreadsheets/d/$SHEET_ID/export?format=pdf&gid=$SHEET_GID&range=$RANGE&portrait=true&scale=4&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&attachment=false&top_margin=0.15&bottom_margin=0.15&left_margin=0.15&right_margin=0.15"

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
FILENAME="studio-daily-report-$(date '+%Y-%m-%d').png"

UP=$(curl -s --max-time 60 -X POST https://slack.com/api/files.getUploadURLExternal \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  --data-urlencode "filename=$FILENAME" \
  --data-urlencode "length=$SIZE")
echo "$UP" | grep -q '"ok":true' || die "files.getUploadURLExternal failed: $UP"

UPLOAD_URL=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload_url"])')
FILE_ID=$(echo "$UP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["file_id"])')

curl -s --max-time 120 -f -F "file=@$WORK/snip.png" "$UPLOAD_URL" > /dev/null \
  || die "uploading the image bytes to Slack failed"

COMMENT=":bar_chart: *$REPORT_TITLE — $TODAY*
<$SHEET_URL|Open the sheet>"

PAYLOAD=$(FILE_ID="$FILE_ID" CH="$SLACK_CHANNEL_ID" TITLE="$REPORT_TITLE — $TODAY" CMT="$COMMENT" python3 -c '
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

echo "posted to Slack channel $SLACK_CHANNEL_ID (file $FILE_ID)"
# Logged so a post can be withdrawn later without files:read to hunt for it.
echo "to remove this post: report.sh --delete-file $FILE_ID"
echo "=== run ok ==="
