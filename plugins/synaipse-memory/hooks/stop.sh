#!/usr/bin/env bash
# Stop hook: assistant turn finished.
# Records ts + transcript_path (the full transcript already lives there and
# the slash command reads it on demand). Once per session it may nudge the
# model to save what it learned: only when the session edited code
# (>= SYNAIPSE_STOP_NUDGE_MIN_EDITS edits, default 3) and wrote nothing to
# Synaipse. The model decides whether anything is worth keeping.
# SYNAIPSE_STOP_NUDGE=0 turns the nudge off.
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
[[ -n "${LINE:-}" ]] && printf '%s\n' "$LINE" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null

# ---- nudge ------------------------------------------------------------------
[[ "${SYNAIPSE_STOP_NUDGE:-1}" == "0" ]] && exit 0
# Continuing because of a stop hook already: never nudge twice in a row.
[[ "$(printf '%s' "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)" == "true" ]] && exit 0
[[ -f "$SYNAIPSE_META_PATH" && -f "$SYNAIPSE_JSONL_PATH" ]] || exit 0
[[ -n "$(jq -r '.nudged_at // empty' "$SYNAIPSE_META_PATH" 2>/dev/null)" ]] && exit 0

COUNTS="$(jq -sr '
  [ (map(select(.kind=="tool" and (.name=="Edit" or .name=="Write" or .name=="NotebookEdit"))) | length),
    (map(select(.kind=="synaipse" and .write==true)) | length) ] | @tsv
' < "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true)"
EDITS="$(printf '%s' "$COUNTS" | cut -f1)"
SAVES="$(printf '%s' "$COUNTS" | cut -f2)"
[[ "${EDITS:-0}" =~ ^[0-9]+$ && "${SAVES:-0}" =~ ^[0-9]+$ ]] || exit 0
(( EDITS >= ${SYNAIPSE_STOP_NUDGE_MIN_EDITS:-3} && SAVES == 0 )) || exit 0

TMP="$(mktemp 2>/dev/null || true)"
[[ -z "${TMP:-}" ]] && exit 0
if jq --arg ts "$TS" '. + {nudged_at:$ts}' "$SYNAIPSE_META_PATH" > "$TMP" 2>/dev/null; then
  mv "$TMP" "$SYNAIPSE_META_PATH"
else
  rm -f "$TMP"
  exit 0
fi

jq -nc --arg edits "$EDITS" '{
  decision: "block",
  reason: ("This session changed code (" + $edits + " edits) but saved nothing to Synaipse. If it produced a decision, a fix with a non-obvious cause or a gotcha worth knowing next time, save it now: synaipse_remember for one insight, synaipse_log_session for a summary with the notes used. If nothing is worth keeping, just finish. This reminder comes once per session.")
}'
exit 0
