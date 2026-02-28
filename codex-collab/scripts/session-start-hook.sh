#!/bin/bash
# Codex Collab SessionStart Hook
# Reads session_id from stdin JSON and persists CLAUDE_SESSION_ID
# via CLAUDE_ENV_FILE so all Bash commands in this session can access it.

set -euo pipefail

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract session_id (requires jq)
if ! command -v jq &>/dev/null; then
  exit 0
fi

SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
if [[ -z "${SESSION_ID:-}" ]]; then
  exit 0
fi

# Write to CLAUDE_ENV_FILE so the session ID persists for all Bash commands
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export CLAUDE_SESSION_ID=\"$SESSION_ID\"" >> "$CLAUDE_ENV_FILE"
fi
