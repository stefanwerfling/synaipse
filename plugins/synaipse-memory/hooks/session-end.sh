#!/usr/bin/env bash
# SessionEnd hook: aggregate stats into meta.json + close out the jsonl.
set -uo pipefail

LIB="$(dirname "$0")/../lib"
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "${SESSION_ID:-}" ]] && exit 0

# shellcheck source=../lib/log-path.sh
. "$LIB/log-path.sh"
[[ ! -f "$SYNAIPSE_JSONL_PATH" ]] && exit 0
[[ ! -f "$SYNAIPSE_META_PATH" ]] && exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

STATS="$(jq -sc '
  {
    tool_call_count: (map(select(.kind=="tool" or .kind=="tool_counter")) | length),
    user_turns:      (map(select(.kind=="user")) | length),
    assistant_turns: (map(select(.kind=="stop")) | length),
    edited_files: (
      map(select(.kind=="tool" and (.name=="Edit" or .name=="Write" or .name=="NotebookEdit"))
          | .input.file_path // .input.notebook_path // empty)
      | map(select(. != ""))
      | unique
    )
  }
' < "$SYNAIPSE_JSONL_PATH" 2>/dev/null || echo '{}')"

TMP="$(mktemp 2>/dev/null || true)"
if [[ -n "${TMP:-}" ]]; then
  if jq --arg ts "$TS" --argjson stats "$STATS" \
       '. + $stats + {ended_at:$ts}' \
       "$SYNAIPSE_META_PATH" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$SYNAIPSE_META_PATH"
  else
    rm -f "$TMP"
  fi
fi

printf '{"ts":"%s","kind":"session_end"}\n' "$TS" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true
exit 0