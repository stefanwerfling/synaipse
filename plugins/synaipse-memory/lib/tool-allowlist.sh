#!/usr/bin/env bash
# Sourced by hook scripts. Provides is_detail_tool().
# Returns 0 (true) for tools whose calls represent project *action* and
# deserve a detailed log entry; returns 1 for recon tools that only get
# a counter line.

is_detail_tool() {
  case "$1" in
    Edit|Write|Bash|NotebookEdit) return 0 ;;
    *) return 1 ;;
  esac
}