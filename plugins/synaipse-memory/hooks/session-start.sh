#!/usr/bin/env bash
# SessionStart hook: fires on new sessions AND on resume.
# Same SESSION_ID -> same jsonl/meta, so resume just appends.
set -uo pipefail

LIB="$(dirname "$0")/../lib"
PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
if [[ -z "${SESSION_ID:-}" ]]; then
  exit 0
fi

# shellcheck source=../lib/log-path.sh
. "$LIB/log-path.sh"
# shellcheck source=../lib/ensure-gitignore.sh
. "$LIB/ensure-gitignore.sh"

ensure_gitignore "$SYNAIPSE_LOG_DIR" || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f "$SYNAIPSE_META_PATH" ]]; then
  CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [[ -z "$CWD" ]] && CWD="$CLAUDE_PROJECT_DIR"
  PROJECT_NAME="${SYNAIPSE_PROJECT:-$(basename "$CWD")}"

  jq -nc \
    --arg sid "$SESSION_ID" \
    --arg proj "$PROJECT_NAME" \
    --arg cwd "$CWD" \
    --arg ts "$TS" \
    '{session_id:$sid, project:$proj, cwd:$cwd, created_at:$ts, status:"draft"}' \
    > "$SYNAIPSE_META_PATH" 2>/dev/null || true
fi

printf '{"ts":"%s","kind":"session_start"}\n' "$TS" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true

exit 0