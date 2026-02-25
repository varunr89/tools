#!/bin/bash
# Sends a design plan to Codex for review.
# Args: $1 = path to design plan file
# Output: Codex review text to stdout
# Side effect: Saves full review to reviews/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PLAN_FILE="${1:?Usage: design-review.sh <plan-file-path>}"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

# Resolve model
MODEL=$("$SCRIPT_DIR/resolve-model.sh")

# Read plan content
PLAN_CONTENT=$(cat "$PLAN_FILE")

# Create reviews directory
REVIEW_DIR="$REPO_ROOT/.claude/codex-collab/reviews"
mkdir -p "$REVIEW_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REVIEW_FILE="$REVIEW_DIR/design-review-$TIMESTAMP.md"

# Build prompt in a temp file (avoids heredoc quoting issues with variable expansion)
PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT

cat > "$PROMPT_FILE" <<PROMPT_EOF
Review this design plan for a software project. Be thorough and specific.

Evaluate:
1. COMPLETENESS: Missing components, edge cases, or integration points?
2. PERFORMANCE: Will this scale? Any bottlenecks?
3. SECURITY: Attack vectors, data exposure, or auth gaps?
4. MAINTAINABILITY: Will this be easy to change later? Proper separation of concerns?
5. SIMPLICITY: Is anything over-engineered? Can anything be simplified?

Format your response as:
## Issues Found
For each issue:
### [CRITICAL|WARNING|INFO]: Brief title
Description of the issue and specific recommendation.

## Strengths
What's good about this design (brief).

## Summary
N issues found (X critical, Y warning, Z info).

---

DESIGN PLAN:

$PLAN_CONTENT
PROMPT_EOF

# Send to Codex (wrap with || true so set -e doesn't kill fallback)
REVIEW_OUTPUT=$(cat "$PROMPT_FILE" | codex exec \
  -m "$MODEL" \
  -c model_reasoning_effort=xhigh \
  -c 'sandbox_permissions=["disk-read-access"]' \
  -c approval=never \
  -c full_auto=true 2>/dev/null || true)

# If codex exec failed or returned empty, try simpler invocation
if [[ -z "$REVIEW_OUTPUT" ]]; then
  REVIEW_OUTPUT=$(cat "$PROMPT_FILE" | codex exec \
    -m "$MODEL" \
    -c model_reasoning_effort=high \
    -c 'sandbox_permissions=["disk-read-access"]' \
    -c approval=never \
    -c full_auto=true 2>/dev/null || echo "Codex review failed. Proceeding without design review.")
fi

# Save full review
cat > "$REVIEW_FILE" <<EOF
---
type: design_review
model: $MODEL
reasoning: xhigh
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
plan_file: $PLAN_FILE
---

# Design Review

$REVIEW_OUTPUT
EOF

# Output the review text (this goes to stdout for the hook to capture)
echo "$REVIEW_OUTPUT"
