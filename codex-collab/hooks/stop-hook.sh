#!/bin/bash
# Codex Collab Stop Hook
# Manages the review lifecycle state machine.
# Uses the advanced Stop hook API: outputs JSON with decision/reason/systemMessage.
# Exit 0 always -- decision: "block" prevents stop, no output allows stop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Read hook input from stdin (advanced stop hook API)
HOOK_INPUT=$(cat)

# ── Preflight checks ────────────────────────────────────────────────

# jq is required for JSON output
if ! command -v jq &>/dev/null; then
  echo "codex-collab: jq not found, skipping review" >&2
  exit 0
fi

# ── Session ID resolution ───────────────────────────────────────────

# Extract session_id from hook input JSON
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
if [[ -z "${SESSION_ID:-}" ]]; then
  # No session ID -- cannot determine which session's state to use
  exit 0
fi

# Export for child scripts (task-review.sh, resolve-model.sh, design-review.sh)
export CODEX_COLLAB_SESSION_ID="$SESSION_ID"

# Session-scoped paths
SESSIONS_DIR="$REPO_ROOT/.claude/codex-collab/sessions"
STATE_FILE="$SESSIONS_DIR/${SESSION_ID}.md"
SKIP_FLAG="$SESSIONS_DIR/${SESSION_ID}.skip"

# ── Escape hatches ──────────────────────────────────────────────────

# Skip flag: allow this one stop, then delete flag
if [[ -f "$SKIP_FLAG" ]]; then
  rm -f "$SKIP_FLAG"
  exit 0
fi

# No state file = no active session
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Parse frontmatter
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")

# Check if paused
PAUSED=$(echo "$FRONTMATTER" | grep '^paused:' | sed 's/paused: *//' || echo "false")
if [[ "$PAUSED" = "true" ]]; then
  exit 0
fi

# Read state
PHASE=$(echo "$FRONTMATTER" | grep '^phase:' | sed 's/phase: *//' || true)
TASK_INDEX=$(echo "$FRONTMATTER" | grep '^task_index:' | sed 's/task_index: *//' || echo "0")
GIT_CHECKPOINT=$(echo "$FRONTMATTER" | grep '^git_checkpoint:' | sed 's/git_checkpoint: *//' || echo "")
PLAN_FILE=$(echo "$FRONTMATTER" | grep '^plan_file:' | sed 's/plan_file: *//' | sed 's/^"\(.*\)"$/\1/' || echo "")

# ── State machine ───────────────────────────────────────────────────

case "$PHASE" in
  idle|complete|"")
    # No active session or session complete -- allow stop
    if [[ "$PHASE" = "complete" ]]; then
      rm -f "$STATE_FILE"
    fi
    exit 0
    ;;

  designing)
    # Claude just finished the design phase.
    # Trigger Codex design review, then transition to implementing.

    # Find the plan file
    if [[ -z "$PLAN_FILE" ]] || [[ ! -f "$PLAN_FILE" ]]; then
      # Try to find the most recent plan file
      PLAN_FILE=$(find docs/plans/ -name "*.md" -type f 2>/dev/null | sort -r | head -1 || echo "")
    fi

    if [[ -z "$PLAN_FILE" ]] || [[ ! -f "$PLAN_FILE" ]]; then
      # No plan file found -- skip design review, go to implementing
      TEMP_FILE="${STATE_FILE}.tmp.$$"
      sed "s/^phase: .*/phase: implementing/" "$STATE_FILE" > "$TEMP_FILE"
      mv "$TEMP_FILE" "$STATE_FILE"

      jq -n '{
        "decision": "block",
        "reason": "No design plan file found for Codex review. Proceeding to implementation. Start working through the implementation tasks.",
        "systemMessage": "Codex Collab: Design review skipped (no plan file). Phase: implementing."
      }'
      exit 0
    fi

    # Run design review (|| true so set -e does not kill us)
    REVIEW=$("$SCRIPT_DIR/design-review.sh" "$PLAN_FILE" 2>/dev/null || true)
    if [[ -z "$REVIEW" ]]; then
      REVIEW="Design review failed. Proceeding without review."
    fi

    # Update state: transition to implementing, set git checkpoint
    CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    TEMP_FILE="${STATE_FILE}.tmp.$$"
    sed "s/^phase: .*/phase: implementing/" "$STATE_FILE" | \
      sed "s/^git_checkpoint: .*/git_checkpoint: $CURRENT_SHA/" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$STATE_FILE"

    # Output JSON to block stop and inject review
    jq -n \
      --arg review "$REVIEW" \
      --arg sysmsg "Codex Collab: Design review complete. Phase: implementing. Address any CRITICAL issues from the review, then begin implementation tasks." \
      '{
        "decision": "block",
        "reason": ("## Codex Design Review\n\nCodex has reviewed your design plan. Here is the feedback:\n\n" + $review + "\n\nPlease address any CRITICAL issues, then begin implementing the tasks. After completing each task, I will automatically trigger a Codex code review."),
        "systemMessage": $sysmsg
      }'
    exit 0
    ;;

  implementing)
    # Claude just finished an implementation task.
    # Trigger Codex task review on the diff since last checkpoint.

    if [[ -z "$GIT_CHECKPOINT" ]]; then
      GIT_CHECKPOINT=$(git rev-parse HEAD~1 2>/dev/null || echo "")
    fi

    # Get diff to check if there are changes
    DIFF_SIZE=$(git diff "$GIT_CHECKPOINT"..HEAD --stat 2>/dev/null | wc -l | tr -d ' ' || echo "0")

    if [[ "$DIFF_SIZE" -le 1 ]]; then
      # No meaningful changes -- allow stop (might be done with all tasks)
      exit 0
    fi

    # Get task description from recent commit messages
    TASK_DESC=$(git log --oneline "$GIT_CHECKPOINT"..HEAD 2>/dev/null | head -5 | paste -sd '; ' - || echo "Implementation task")

    # Run task review (|| true so set -e does not kill us)
    REVIEW=$("$SCRIPT_DIR/task-review.sh" "$GIT_CHECKPOINT" "$TASK_DESC" 2>/dev/null || true)
    if [[ -z "$REVIEW" ]]; then
      REVIEW="Task review unavailable. Proceeding."
    fi

    # Update state: increment task index, update checkpoint
    CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    NEXT_INDEX=$((TASK_INDEX + 1))
    TEMP_FILE="${STATE_FILE}.tmp.$$"
    sed "s/^task_index: .*/task_index: $NEXT_INDEX/" "$STATE_FILE" | \
      sed "s/^git_checkpoint: .*/git_checkpoint: $CURRENT_SHA/" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$STATE_FILE"

    # Check if review found issues
    CRITICAL_COUNT=$(echo "$REVIEW" | grep -ci "CRITICAL" || echo "0")
    WARNING_COUNT=$(echo "$REVIEW" | grep -ci "WARNING" || echo "0")

    if [[ "$CRITICAL_COUNT" -eq 0 ]] && [[ "$WARNING_COUNT" -eq 0 ]]; then
      # Clean review -- show summary and continue
      jq -n \
        --arg review "$REVIEW" \
        --argjson task_idx "$NEXT_INDEX" \
        --arg sysmsg "Codex Collab: Task review complete (clean). Task $NEXT_INDEX. Continue to next task." \
        '{
          "decision": "block",
          "reason": ("## Codex Task Review (Task " + ($task_idx | tostring) + ")\n\nCodex reviewed your changes. No critical or warning issues found.\n\n" + $review + "\n\nGood work. Continue to the next task."),
          "systemMessage": $sysmsg
        }'
    else
      # Issues found -- block and ask Claude to fix
      jq -n \
        --arg review "$REVIEW" \
        --argjson task_idx "$NEXT_INDEX" \
        --argjson critical "$CRITICAL_COUNT" \
        --argjson warning "$WARNING_COUNT" \
        --arg sysmsg "Codex Collab: Task review found issues. Fix them before continuing." \
        '{
          "decision": "block",
          "reason": ("## Codex Task Review (Task " + ($task_idx | tostring) + ")\n\nCodex found issues in your implementation:\n- " + ($critical | tostring) + " critical\n- " + ($warning | tostring) + " warning\n\n" + $review + "\n\nPlease address the CRITICAL and WARNING issues, then continue to the next task. Show a brief summary of what you fixed."),
          "systemMessage": $sysmsg
        }'
    fi
    exit 0
    ;;

  *)
    # Unknown phase -- allow stop
    exit 0
    ;;
esac
