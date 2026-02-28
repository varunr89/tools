#!/bin/bash
# Resolves the latest Codex model and caches it.
# Output: the model name (e.g., "gpt-5.2-codex")
# Priority: user override > codex config > fallback

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
FALLBACK_MODEL="gpt-5.2-codex"

# ── Session ID resolution ───────────────────────────────────────────

SESSION_ID="${CODEX_COLLAB_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"

# Check for user override in session state frontmatter
if [[ -n "${SESSION_ID:-}" ]]; then
  STATE_FILE="$REPO_ROOT/.claude/codex-collab/sessions/${SESSION_ID}.md"
  if [[ -f "$STATE_FILE" ]]; then
    OVERRIDE=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE" | grep '^model_override:' | sed 's/model_override: *//' | sed 's/^"\(.*\)"$/\1/' || true)
    if [[ -n "${OVERRIDE:-}" ]] && [[ "$OVERRIDE" != "null" ]]; then
      echo "$OVERRIDE"
      exit 0
    fi
  fi
fi

# Try to get model from codex config
if command -v codex &>/dev/null; then
  CONFIGURED_MODEL=$(codex config get model 2>/dev/null || true)
  if [[ -n "$CONFIGURED_MODEL" ]] && [[ "$CONFIGURED_MODEL" == *-codex* ]]; then
    echo "$CONFIGURED_MODEL"
    exit 0
  fi
  # If configured model is not a codex variant, try appending -codex
  if [[ -n "$CONFIGURED_MODEL" ]]; then
    echo "${CONFIGURED_MODEL%-codex}-codex"
    exit 0
  fi
fi

echo "$FALLBACK_MODEL"
