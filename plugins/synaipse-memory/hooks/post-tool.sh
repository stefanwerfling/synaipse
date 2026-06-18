#!/usr/bin/env bash
# PostToolUse hook: per-tool record.
# Action tools (Edit/Write/Bash/NotebookEdit): full input + 200-char result preview.
# Other tools (Read/Glob/Grep/...): counter line only, no args, no preview.
set -uo pipefail

LIB="$(dirname "$0")/../lib"
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "${SESSION_ID:-}" ]] && exit 0

# shellcheck source=../lib/log-path.sh
. "$LIB/log-path.sh"
# shellcheck source=../lib/tool-allowlist.sh
. "$LIB/tool-allowlist.sh"
[[ ! -d "$SYNAIPSE_LOG_DIR" ]] && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null || true)"
[[ -z "${TOOL:-}" ]] && exit 0

if is_detail_tool "$TOOL"; then
  LINE="$(printf '%s' "$PAYLOAD" | jq -c --arg ts "$TS" '
    {ts:$ts, kind:"tool", name:.tool_name,
     input:.tool_input,
     result_size:((.tool_response | tostring) | length),
     result_preview:((.tool_response | tostring)[0:200])}
  ' 2>/dev/null || true)"
else
  LINE="$(printf '%s' "$PAYLOAD" | jq -c --arg ts "$TS" '
    {ts:$ts, kind:"tool_counter", name:.tool_name,
     result_size:((.tool_response | tostring) | length)}
  ' 2>/dev/null || true)"
fi

[[ -z "${LINE:-}" ]] && exit 0
printf '%s\n' "$LINE" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true
exit 0