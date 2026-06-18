#!/usr/bin/env bash
# Stop hook: assistant turn finished.
# We only record ts + transcript_path; the full transcript already lives
# in transcript_path and the slash command reads it on demand.
set -uo pipefail

LIB="$(dirname "$0")/../lib"
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "${SESSION_ID:-}" ]] && exit 0

# shellcheck source=../lib/log-path.sh
. "$LIB/log-path.sh"
[[ ! -d "$SYNAIPSE_LOG_DIR" ]] && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null || true)"

LINE="$(jq -nc --arg ts "$TS" --arg t "$TRANSCRIPT" \
  '{ts:$ts, kind:"stop", transcript_path:$t}' 2>/dev/null || true)"
[[ -z "${LINE:-}" ]] && exit 0

printf '%s\n' "$LINE" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true
exit 0