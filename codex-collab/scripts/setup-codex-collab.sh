#!/bin/bash
# Initializes a codex-collab session.
# Creates the per-session state file and prints activation message.
# Args: $@ = task description (all remaining args joined)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── Session ID resolution ───────────────────────────────────────────

SESSION_ID="${CODEX_COLLAB_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
if [[ -z "$SESSION_ID" ]]; then
  echo "ERROR: No session ID available. CLAUDE_SESSION_ID must be set by the SessionStart hook." >&2
  echo "This usually means the session-start-hook.sh is not registered in ~/.claude/settings.json." >&2
  exit 1
fi

# Session-scoped paths
SESSIONS_DIR="$REPO_ROOT/.claude/codex-collab/sessions"
STATE_FILE="$SESSIONS_DIR/${SESSION_ID}.md"

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
mkdir -p "$SESSIONS_DIR"
mkdir -p "$REPO_ROOT/.claude/codex-collab/reviews"

# ── Migrate old state file if present ───────────────────────────────

OLD_STATE="$REPO_ROOT/.claude/codex-collab.local.md"
if [[ -f "$OLD_STATE" ]]; then
  echo "WARNING: Found old state file at .claude/codex-collab.local.md"
  echo "         Per-session state is now at .claude/codex-collab/sessions/"
  echo "         Removing old file."
  rm -f "$OLD_STATE"
  rm -f "$REPO_ROOT/.claude/codex-collab.skip"
fi

# ── Create session state ────────────────────────────────────────────

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

Session: ${SESSION_ID:0:12}...
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
