#!/bin/bash
# Codex Collab SessionEnd Hook
# Cleans up per-session state file and skip flag when a session ends.

set -euo pipefail

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract session_id and cwd (requires jq)
if ! command -v jq &>/dev/null; then
  exit 0
fi

SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty')

if [[ -z "${SESSION_ID:-}" ]] || [[ -z "${CWD:-}" ]]; then
  exit 0
fi

# Determine repo root from cwd
REPO_ROOT=$(cd "$CWD" && git rev-parse --show-toplevel 2>/dev/null || echo "$CWD")

# Remove session state file and skip flag if they exist
rm -f "$REPO_ROOT/.claude/codex-collab/sessions/${SESSION_ID}.md"
rm -f "$REPO_ROOT/.claude/codex-collab/sessions/${SESSION_ID}.skip"
