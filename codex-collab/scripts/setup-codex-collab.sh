#!/bin/bash
# Initializes a codex-collab session.
# Creates the state file and prints activation message.
# Args: $@ = task description (all remaining args joined)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE_FILE="$REPO_ROOT/.claude/codex-collab.local.md"

# Check if already active
if [[ -f "$STATE_FILE" ]]; then
  PHASE=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE" | grep '^phase:' | sed 's/phase: *//')
  if [[ "$PHASE" != "idle" ]] && [[ "$PHASE" != "complete" ]]; then
    echo "A codex-collab session is already active (phase: $PHASE)."
    echo "Use /codex-cancel to end it first, or /codex-status to check progress."
    exit 1
  fi
fi

# Check codex CLI is available
if ! command -v codex &>/dev/null; then
  echo "ERROR: codex CLI not found. Install with: npm install -g @openai/codex-cli" >&2
  exit 1
fi

# Check jq is available
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq not found. Install with: brew install jq" >&2
  exit 1
fi

# Resolve and cache model
MODEL=$("$SCRIPT_DIR/resolve-model.sh" 2>/dev/null || echo "gpt-5.2-codex")

# Get current git SHA as initial checkpoint
GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Parse task description from arguments
TASK_DESC="${*:-}"

# Create state directories
mkdir -p "$REPO_ROOT/.claude"
mkdir -p "$REPO_ROOT/.claude/codex-collab/reviews"

cat > "$STATE_FILE" <<EOF
---
phase: designing
task_index: 0
git_checkpoint: $GIT_SHA
plan_file: ""
paused: false
cached_model: $MODEL
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---

$TASK_DESC
EOF

# Output activation message
cat <<EOF
Codex Collab session activated!

Model: $MODEL
Reasoning: high/xhigh (context-dependent)
Git checkpoint: ${GIT_SHA:0:8}

WORKFLOW:
1. Design phase (current) -- work on your design/plan as normal
2. When you finish designing, Codex will automatically review the plan
3. Implementation phase -- work through tasks one at a time
4. After each task, Codex will automatically review your code changes

CONTROLS:
  /codex-status  -- check session state
  /codex-pause   -- pause auto-reviews
  /codex-resume  -- resume auto-reviews
  /codex-skip    -- skip the next review only
  /codex-cancel  -- end session
EOF

if [[ -n "$TASK_DESC" ]]; then
  echo ""
  echo "TASK: $TASK_DESC"
fi
