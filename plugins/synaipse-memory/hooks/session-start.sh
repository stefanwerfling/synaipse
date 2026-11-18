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

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)"
[[ -z "$CWD" ]] && CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
# Same rule as the MCP server for X-Synaipse-Project-Dir (plugin .mcp.json):
# the folder name, characters outside [A-Za-z0-9_.-] replaced by "-".
PROJECT_NAME="${SYNAIPSE_PROJECT:-$(basename "$CWD" | sed -E 's/[^A-Za-z0-9_.-]+/-/g; s/^-+//; s/-+$//')}"
# On resume the meta file already exists — keep the project recorded there.
if [[ -f "$SYNAIPSE_META_PATH" ]]; then
  META_PROJECT="$(jq -r '.project // empty' "$SYNAIPSE_META_PATH" 2>/dev/null || true)"
  [[ -n "$META_PROJECT" ]] && PROJECT_NAME="$META_PROJECT"
fi

if [[ ! -f "$SYNAIPSE_META_PATH" ]]; then
  jq -nc \
    --arg sid "$SESSION_ID" \
    --arg proj "$PROJECT_NAME" \
    --arg cwd "$CWD" \
    --arg ts "$TS" \
    '{session_id:$sid, project:$proj, cwd:$cwd, created_at:$ts, status:"draft"}' \
    > "$SYNAIPSE_META_PATH" 2>/dev/null || true
fi

printf '{"ts":"%s","kind":"session_start"}\n' "$TS" >> "$SYNAIPSE_JSONL_PATH" 2>/dev/null || true

# Refresh the curated primer that CLAUDE.md can @-import. Best-effort:
# silently no-op if curl is missing or the web API is down.
if command -v curl >/dev/null 2>&1; then
  PORT="${SYNAIPSE_WEB_API_PORT:-3001}"
  PRIMER_DIR="${CLAUDE_PROJECT_DIR:-$CWD}/.claude"
  PRIMER_PATH="${PRIMER_DIR}/synaipse-primer.md"
  PRIMER_TMP="${PRIMER_PATH}.tmp.$$"

  mkdir -p "$PRIMER_DIR" 2>/dev/null || true

  # Pass the project explicitly — otherwise the server falls back to its
  # own env project and every repo gets the same primer.
  if curl --silent --show-error --fail --max-time 5 --get \
      --data-urlencode "format=markdown" \
      --data-urlencode "project=${PROJECT_NAME}" \
      "http://localhost:${PORT}/api/prime" \
      -o "$PRIMER_TMP" 2>/dev/null; then
    mv -f "$PRIMER_TMP" "$PRIMER_PATH" 2>/dev/null || rm -f "$PRIMER_TMP" 2>/dev/null
  else
    rm -f "$PRIMER_TMP" 2>/dev/null
  fi
fi

# Hand the primer straight to the model as SessionStart additionalContext,
# so no CLAUDE.md @-import is needed. Skipped when it would land twice:
#   - on resume the earlier injection is already part of the restored transcript;
#   - a CLAUDE.md that still @-imports the primer file already loads it.
# Opt out with SYNAIPSE_PRIMER_INJECT=0. Capped so a huge primer can't
# flood the context (the server targets < 2k tokens anyway).
PRIMER_FILE="${CLAUDE_PROJECT_DIR:-$CWD}/.claude/synaipse-primer.md"
SOURCE="$(printf '%s' "$PAYLOAD" | jq -r '.source // empty' 2>/dev/null || true)"
PRIMER_MAX_BYTES="${SYNAIPSE_PRIMER_MAX_BYTES:-12000}"

primer_imported_by_claude_md() {
  local root="${CLAUDE_PROJECT_DIR:-$CWD}" f
  for f in "$root/CLAUDE.md" "$root/.claude/CLAUDE.md" "$root/CLAUDE.local.md"; do
    [[ -f "$f" ]] && grep -q 'synaipse-primer\.md' "$f" 2>/dev/null && return 0
  done
  return 1
}

if [[ "${SYNAIPSE_PRIMER_INJECT:-1}" != "0" && "$SOURCE" != "resume" && -s "$PRIMER_FILE" ]] \
    && ! primer_imported_by_claude_md; then
  head -c "$PRIMER_MAX_BYTES" "$PRIMER_FILE" 2>/dev/null \
    | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: ("# Synaipse memory primer\n\n" + .)}}' 2>/dev/null \
    || true
fi

exit 0