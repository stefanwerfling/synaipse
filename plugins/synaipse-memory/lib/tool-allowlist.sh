#!/usr/bin/env bash
# Sourced by hook scripts. Provides is_detail_tool() and is_synaipse_tool().
# is_detail_tool: tools whose calls represent project *action* and deserve
# a detailed log entry; recon tools only get a counter line.
# is_synaipse_tool: calls of the Synaipse MCP server, whichever way it is
# registered (mcp__synaipse__…, mcp__plugin_synaipse-memory_synaipse__…).

is_detail_tool() {
  case "$1" in
    Edit|Write|Bash|NotebookEdit) return 0 ;;
    *) return 1 ;;
  esac
}

is_synaipse_tool() {
  case "$1" in
    mcp__*synaipse*__synaipse_*) return 0 ;;
    *) return 1 ;;
  esac
}

# Synaipse tools that change the vault (the Stop hook counts these as "saved").
SYNAIPSE_WRITE_OPS='["write_note","update_note","edit_note","remember","log_session","link_note","delete_note","write_asset"]'
