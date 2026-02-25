#!/bin/bash
# Reviews code changes for a specific implementation task.
# Args: $1 = git checkpoint SHA, $2 = task description (optional)
# Output: Codex review text to stdout
# Side effect: Saves full review to reviews/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CHECKPOINT="${1:?Usage: task-review.sh <git-checkpoint-sha> [task-description]}"
TASK_DESC="${2:-Implementation task}"

# Get the diff
DIFF=$(git diff "$CHECKPOINT"..HEAD 2>/dev/null || echo "")
if [[ -z "$DIFF" ]]; then
  echo "No changes since checkpoint $CHECKPOINT. Skipping review."
  exit 0
fi

# Get changed files list
CHANGED_FILES=$(git diff --name-only "$CHECKPOINT"..HEAD 2>/dev/null || echo "")
LINES_CHANGED=$(echo "$DIFF" | wc -l | tr -d ' ')

# Resolve model
MODEL=$("$SCRIPT_DIR/resolve-model.sh")

# Determine reasoning level based on context
SECURITY_FILES=$(echo "$CHANGED_FILES" | grep -iE 'auth|crypto|secret|security|\.key|\.pem|password|token' || echo "")
if [[ -n "$SECURITY_FILES" ]] || [[ "$LINES_CHANGED" -gt 200 ]]; then
  REASONING="xhigh"
else
  REASONING="high"
fi

# Create reviews directory
REVIEW_DIR="$REPO_ROOT/.claude/codex-collab/reviews"
mkdir -p "$REVIEW_DIR"

# Determine task index from state file
TASK_INDEX="0"
STATE_FILE="$REPO_ROOT/.claude/codex-collab.local.md"
if [[ -f "$STATE_FILE" ]]; then
  TASK_INDEX=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE" | grep '^task_index:' | sed 's/task_index: *//' || echo "0")
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REVIEW_FILE="$REVIEW_DIR/task-${TASK_INDEX}-review-$TIMESTAMP.md"

# Build prompt in a temp file
PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT

cat > "$PROMPT_FILE" <<PROMPT_EOF
Review these code changes for an implementation task.

TASK: $TASK_DESC

CHANGED FILES:
$CHANGED_FILES

LINES CHANGED: $LINES_CHANGED

Evaluate:
1. CORRECTNESS: Bugs, logic errors, off-by-one errors?
2. PERFORMANCE: Unnecessary allocations, O(n^2) where O(n) is possible, blocking calls?
3. MAINTAINABILITY: Unclear naming, missing error handling, tight coupling?
4. BEST PRACTICES: Language/framework idioms, consistent patterns?
5. EDGE CASES: Null/empty inputs, concurrency issues, error paths?

Format your response as:
For each issue:
SEVERITY: FILE:LINE - description and recommendation

Then a brief summary line: N issues found (X critical, Y warning, Z info).

DIFF:
$DIFF
PROMPT_EOF

# Send to Codex (wrap with || true for set -e safety)
REVIEW_OUTPUT=$(cat "$PROMPT_FILE" | codex exec \
  -m "$MODEL" \
  -c "model_reasoning_effort=$REASONING" \
  -c 'sandbox_permissions=["disk-read-access"]' \
  -c approval=never \
  -c full_auto=true 2>/dev/null || echo "Codex review unavailable. Proceeding without task review.")

# Save full review
cat > "$REVIEW_FILE" <<EOF
---
type: task_review
task_index: $TASK_INDEX
task_description: "$TASK_DESC"
model: $MODEL
reasoning: $REASONING
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
files_reviewed: $CHANGED_FILES
lines_changed: $LINES_CHANGED
---

# Task $TASK_INDEX Review

$REVIEW_OUTPUT
EOF

# Output the review text
echo "$REVIEW_OUTPUT"
