#!/usr/bin/env bash
# UserPromptSubmit hook: records each user turn.
set -uo pipefail

LIB="$(dirname "$0")/../lib"
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "${SESSION_ID:-}" ]] && exit 0

# shellcheck source=../lib/log-path.sh
. "$LIB/log-path.sh"
[[ ! -d "$SYNAIPSE_LOG_DIR" ]] && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

LINE="$(printf '%s' "$PAYLOAD" | jq -c --arg ts "$TS" \
  '{ts:$ts, kind:"user", text:(.prompt // .user_prompt // "")}' 2>/dev/null || true)"
[[ -z "${LINE:-}" ]] && exit 0

printf '%s\n' "$LINE" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true
exit 0