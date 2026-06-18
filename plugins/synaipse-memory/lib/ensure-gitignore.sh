#!/usr/bin/env bash
# Sourced by hook scripts. Provides ensure_gitignore().
# Drops a local .gitignore in the session-log dir so raw transcripts
# (which may contain secrets in tool args) never get committed.

ensure_gitignore() {
  local dir="$1"
  mkdir -p "$dir"
  if [[ ! -f "$dir/.gitignore" ]]; then
    printf '%s\n%s\n' '*' '!.gitignore' > "$dir/.gitignore"
  fi
}