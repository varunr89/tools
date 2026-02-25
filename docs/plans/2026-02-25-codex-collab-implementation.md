# Codex Collab Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that automatically triggers Codex reviews after design completion and each implementation task, using the Stop hook API.

**Architecture:** A plugin with a Stop hook that manages a state machine (IDLE -> DESIGNING -> DESIGN_REVIEW -> IMPLEMENTING -> TASK_REVIEW -> COMPLETE). The hook outputs structured JSON (`decision: "block"`) to inject Codex feedback back into Claude's context. State is tracked in `.claude/codex-collab.local.md` with YAML frontmatter.

**Tech Stack:** Bash scripts, `codex` CLI, `jq` for JSON, Claude Code plugin API (Stop hook advanced API with `decision`/`reason`/`systemMessage`).

**Design doc:** `docs/plans/2026-02-25-codex-collab-design.md`

---

### Task 1: Plugin Scaffold & Manifest

**Files:**
- Create: `codex-collab/.claude-plugin/plugin.json`
- Create: `codex-collab/hooks/hooks.json`

**Step 1: Create plugin directory structure**

```bash
mkdir -p codex-collab/.claude-plugin
mkdir -p codex-collab/hooks
mkdir -p codex-collab/commands
mkdir -p codex-collab/skills
mkdir -p codex-collab/scripts
```

**Step 2: Write plugin manifest**

Create `codex-collab/.claude-plugin/plugin.json`:
```json
{
  "name": "codex-collab",
  "description": "Automated Codex reviews during design and implementation. Seamlessly integrates Claude Code and Codex CLI via Stop hooks.",
  "author": {
    "name": "Varun R"
  }
}
```

**Step 3: Write hooks registration**

Create `codex-collab/hooks/hooks.json`:
```json
{
  "description": "Codex collab Stop hook for automated reviews",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh"
          }
        ]
      }
    ]
  }
}
```

**Step 4: Commit**

```bash
git add codex-collab/
git commit -m "feat(codex-collab): scaffold plugin with manifest and hook registration"
```

---

### Task 2: Model Resolution Script

**Files:**
- Create: `codex-collab/scripts/resolve-model.sh`

**Step 1: Write the model resolution script**

Create `codex-collab/scripts/resolve-model.sh`:
```bash
#!/bin/bash
# Resolves the latest Codex model and caches it.
# Output: the model name (e.g., "gpt-5.2-codex")
# Uses codex CLI's configured default if available,
# otherwise falls back to hardcoded default.

set -euo pipefail

STATE_FILE=".claude/codex-collab.local.md"
FALLBACK_MODEL="gpt-5.2-codex"

# Check for user override in local.md frontmatter
if [[ -f "$STATE_FILE" ]]; then
  OVERRIDE=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE" | grep '^model_override:' | sed 's/model_override: *//' | sed 's/^"\(.*\)"$/\1/')
  if [[ -n "$OVERRIDE" ]] && [[ "$OVERRIDE" != "null" ]]; then
    echo "$OVERRIDE"
    exit 0
  fi
fi

# Try to get model from codex config
if command -v codex &>/dev/null; then
  CONFIGURED_MODEL=$(codex config get model 2>/dev/null || echo "")
  if [[ -n "$CONFIGURED_MODEL" ]] && [[ "$CONFIGURED_MODEL" == *-codex* ]]; then
    echo "$CONFIGURED_MODEL"
    exit 0
  fi
  # If configured model is not a codex variant, fall back
  if [[ -n "$CONFIGURED_MODEL" ]]; then
    # Try appending -codex if it's a base model name
    echo "${CONFIGURED_MODEL%-codex}-codex"
    exit 0
  fi
fi

echo "$FALLBACK_MODEL"
```

**Step 2: Make executable and test**

```bash
chmod +x codex-collab/scripts/resolve-model.sh
./codex-collab/scripts/resolve-model.sh
```

Expected: outputs a model name like `gpt-5.2-codex`

**Step 3: Commit**

```bash
git add codex-collab/scripts/resolve-model.sh
git commit -m "feat(codex-collab): add model resolution script with caching and override"
```

---

### Task 3: Design Review Script

**Files:**
- Create: `codex-collab/scripts/design-review.sh`

**Step 1: Write design-review.sh**

Create `codex-collab/scripts/design-review.sh`:
```bash
#!/bin/bash
# Sends a design plan to Codex for review.
# Args: $1 = path to design plan file
# Output: Codex review text to stdout
# Side effect: Saves full review to reviews/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
REVIEW_DIR=".claude/codex-collab/reviews"
mkdir -p "$REVIEW_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REVIEW_FILE="$REVIEW_DIR/design-review-$TIMESTAMP.md"

# Send to Codex
REVIEW_OUTPUT=$(cat <<'PROMPT_EOF' | codex exec \
  -c "model=$MODEL" \
  -c model_reasoning_effort=extra-high \
  -c 'sandbox_permissions=["disk-read-access"]' \
  -c approval=never \
  -c full_auto=true 2>/dev/null
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

PROMPT_EOF
)

# If codex exec failed or returned empty, create a minimal output
if [[ -z "$REVIEW_OUTPUT" ]]; then
  # Retry with plan content passed differently
  REVIEW_OUTPUT=$(echo "Review this design plan. List issues as CRITICAL/WARNING/INFO with specific recommendations.

DESIGN PLAN:
$PLAN_CONTENT" | codex exec \
    -c "model=$MODEL" \
    -c model_reasoning_effort=extra-high \
    -c 'sandbox_permissions=["disk-read-access"]' \
    -c approval=never \
    -c full_auto=true 2>/dev/null || echo "Codex review failed. Proceeding without design review.")
fi

# Save full review
cat > "$REVIEW_FILE" <<EOF
---
type: design_review
model: $MODEL
reasoning: extra-high
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
plan_file: $PLAN_FILE
---

# Design Review

$REVIEW_OUTPUT
EOF

# Output the review text (this goes to stdout for the hook to capture)
echo "$REVIEW_OUTPUT"
```

**Step 2: Make executable**

```bash
chmod +x codex-collab/scripts/design-review.sh
```

**Step 3: Commit**

```bash
git add codex-collab/scripts/design-review.sh
git commit -m "feat(codex-collab): add design review script with Codex integration"
```

---

### Task 4: Task Review Script

**Files:**
- Create: `codex-collab/scripts/task-review.sh`

**Step 1: Write task-review.sh**

Create `codex-collab/scripts/task-review.sh`:
```bash
#!/bin/bash
# Reviews code changes for a specific implementation task.
# Args: $1 = git checkpoint SHA, $2 = task description (optional)
# Output: Codex review text to stdout
# Side effect: Saves full review to reviews/ directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Determine reasoning level
SECURITY_FILES=$(echo "$CHANGED_FILES" | grep -iE 'auth|crypto|secret|security|\.key|\.pem|password|token' || echo "")
if [[ -n "$SECURITY_FILES" ]] || [[ "$LINES_CHANGED" -gt 200 ]]; then
  REASONING="extra-high"
else
  REASONING="high"
fi

# Create reviews directory
REVIEW_DIR=".claude/codex-collab/reviews"
mkdir -p "$REVIEW_DIR"

# Determine task index from state file
TASK_INDEX="0"
STATE_FILE=".claude/codex-collab.local.md"
if [[ -f "$STATE_FILE" ]]; then
  TASK_INDEX=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE" | grep '^task_index:' | sed 's/task_index: *//' || echo "0")
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REVIEW_FILE="$REVIEW_DIR/task-${TASK_INDEX}-review-$TIMESTAMP.md"

# Send to Codex
REVIEW_OUTPUT=$(echo "Review these code changes for an implementation task.

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
$DIFF" | codex exec \
  -c "model=$MODEL" \
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
```

**Step 2: Make executable**

```bash
chmod +x codex-collab/scripts/task-review.sh
```

**Step 3: Commit**

```bash
git add codex-collab/scripts/task-review.sh
git commit -m "feat(codex-collab): add task review script with context-aware reasoning"
```

---

### Task 5: Stop Hook -- The Core Lifecycle Engine

**Files:**
- Create: `codex-collab/hooks/stop-hook.sh`

This is the most critical file. It manages the state machine and decides when/how to invoke Codex.

**Step 1: Write stop-hook.sh**

Create `codex-collab/hooks/stop-hook.sh`:
```bash
#!/bin/bash
# Codex Collab Stop Hook
# Manages the review lifecycle state machine.
# Uses the advanced Stop hook API: outputs JSON with decision/reason/systemMessage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
STATE_FILE=".claude/codex-collab.local.md"

# Read hook input from stdin (advanced stop hook API)
HOOK_INPUT=$(cat)

# ── Escape hatches ──────────────────────────────────────────────────

# Skip flag: allow this one stop, then delete flag
if [[ -f ".claude/codex-collab.skip" ]]; then
  rm -f ".claude/codex-collab.skip"
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
if [[ "$PAUSED" == "true" ]]; then
  exit 0
fi

# Read state
PHASE=$(echo "$FRONTMATTER" | grep '^phase:' | sed 's/phase: *//')
TASK_INDEX=$(echo "$FRONTMATTER" | grep '^task_index:' | sed 's/task_index: *//' || echo "0")
GIT_CHECKPOINT=$(echo "$FRONTMATTER" | grep '^git_checkpoint:' | sed 's/git_checkpoint: *//' || echo "")
PLAN_FILE=$(echo "$FRONTMATTER" | grep '^plan_file:' | sed 's/plan_file: *//' | sed 's/^"\(.*\)"$/\1/' || echo "")

# ── State machine ───────────────────────────────────────────────────

case "$PHASE" in
  idle|complete|"")
    # No active session or session complete -- allow stop
    if [[ "$PHASE" == "complete" ]]; then
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
      update_phase "implementing"
      jq -n '{
        "decision": "block",
        "reason": "No design plan file found for Codex review. Proceeding to implementation. Start working through the implementation tasks.",
        "systemMessage": "Codex Collab: Design review skipped (no plan file). Phase: implementing."
      }'
      exit 0
    fi

    # Run design review
    REVIEW=$("$PLUGIN_ROOT/scripts/design-review.sh" "$PLAN_FILE" 2>/dev/null || echo "Design review failed. Proceeding without review.")

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

    # Run task review
    REVIEW=$("$PLUGIN_ROOT/scripts/task-review.sh" "$GIT_CHECKPOINT" "$TASK_DESC" 2>/dev/null || echo "Task review unavailable. Proceeding.")

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
    INFO_COUNT=$(echo "$REVIEW" | grep -ci "INFO" || echo "0")

    if [[ "$CRITICAL_COUNT" -eq 0 ]] && [[ "$WARNING_COUNT" -eq 0 ]]; then
      # Clean review -- show summary but allow Claude to continue naturally
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
```

**Step 2: Make executable**

```bash
chmod +x codex-collab/hooks/stop-hook.sh
```

**Step 3: Smoke test the hook with mock state**

```bash
# Create a mock state file
mkdir -p .claude
cat > .claude/codex-collab.local.md <<'EOF'
---
phase: idle
task_index: 0
git_checkpoint: ""
plan_file: ""
paused: false
---
EOF

# Test idle state (should exit 0 silently)
echo '{}' | ./codex-collab/hooks/stop-hook.sh
echo "Exit code: $?"

# Clean up
rm .claude/codex-collab.local.md
```

Expected: Exit code 0, no output.

**Step 4: Commit**

```bash
git add codex-collab/hooks/stop-hook.sh
git commit -m "feat(codex-collab): add Stop hook lifecycle engine with state machine"
```

---

### Task 6: Setup Script (State Initialization)

**Files:**
- Create: `codex-collab/scripts/setup-codex-collab.sh`

**Step 1: Write setup script**

Create `codex-collab/scripts/setup-codex-collab.sh`:
```bash
#!/bin/bash
# Initializes a codex-collab session.
# Creates the state file and prints activation message.
# Args: $@ = task description (all remaining args joined)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE=".claude/codex-collab.local.md"

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

# Resolve and cache model
MODEL=$("$SCRIPT_DIR/resolve-model.sh" 2>/dev/null || echo "gpt-5.2-codex")

# Get current git SHA as initial checkpoint
GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Parse task description from arguments
TASK_DESC="${*:-}"

# Create state file
mkdir -p .claude
mkdir -p .claude/codex-collab/reviews

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
Reasoning: high/extra-high (context-dependent)
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

Now proceed with designing the solution.
EOF

if [[ -n "$TASK_DESC" ]]; then
  echo ""
  echo "TASK: $TASK_DESC"
fi
```

**Step 2: Make executable**

```bash
chmod +x codex-collab/scripts/setup-codex-collab.sh
```

**Step 3: Commit**

```bash
git add codex-collab/scripts/setup-codex-collab.sh
git commit -m "feat(codex-collab): add session setup script with model caching"
```

---

### Task 7: Slash Commands

**Files:**
- Create: `codex-collab/commands/codex-collab.md`
- Create: `codex-collab/commands/codex-status.md`
- Create: `codex-collab/commands/codex-pause.md`
- Create: `codex-collab/commands/codex-resume.md`
- Create: `codex-collab/commands/codex-skip.md`
- Create: `codex-collab/commands/codex-cancel.md`

**Step 1: Write /codex-collab command**

Create `codex-collab/commands/codex-collab.md`:
```markdown
---
description: "Start a Codex-collaborative development session with automated reviews"
argument-hint: "[task description]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-codex-collab.sh:*)"]
---

# Codex Collab

Execute the setup script to initialize the session:

` ` `!
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-codex-collab.sh" $ARGUMENTS
` ` `

You are now in a Codex Collab session. The Stop hook will automatically trigger Codex reviews at key points.

**Your current phase is DESIGNING.** Work on the design/plan for this task using your normal brainstorming and planning workflow. When you finish the design and try to stop, the hook will automatically send it to Codex for review before you begin implementation.

IMPORTANT: When you write the design plan to a file, update the state file's plan_file field so the hook knows where to find it:

` ` `bash
sed -i '' "s|^plan_file: .*|plan_file: \"docs/plans/YOUR-PLAN-FILE.md\"|" .claude/codex-collab.local.md
` ` `
```

(Note: the backticks above have spaces added to prevent markdown parsing issues in this plan. Remove the spaces in the actual file.)

**Step 2: Write /codex-status command**

Create `codex-collab/commands/codex-status.md`:
```markdown
---
description: "Check current Codex Collab session status"
---

# Codex Status

Read and display the current session state:

` ` `!
if [ -f .claude/codex-collab.local.md ]; then
  echo "=== Codex Collab Status ==="
  head -20 .claude/codex-collab.local.md
  echo ""
  echo "=== Reviews ==="
  ls -la .claude/codex-collab/reviews/ 2>/dev/null || echo "No reviews yet."
else
  echo "No active Codex Collab session."
fi
` ` `
```

**Step 3: Write /codex-pause command**

Create `codex-collab/commands/codex-pause.md`:
```markdown
---
description: "Pause Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Pause

Pause the auto-review loop:

` ` `!
if [ -f .claude/codex-collab.local.md ]; then
  sed -i '' 's/^paused: false/paused: true/' .claude/codex-collab.local.md
  echo "Codex Collab paused. Reviews will not trigger until you run /codex-resume."
else
  echo "No active Codex Collab session."
fi
` ` `
```

**Step 4: Write /codex-resume command**

Create `codex-collab/commands/codex-resume.md`:
```markdown
---
description: "Resume Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Resume

Resume the auto-review loop:

` ` `!
if [ -f .claude/codex-collab.local.md ]; then
  sed -i '' 's/^paused: true/paused: false/' .claude/codex-collab.local.md
  echo "Codex Collab resumed. Auto-reviews are active again."
else
  echo "No active Codex Collab session."
fi
` ` `
```

**Step 5: Write /codex-skip command**

Create `codex-collab/commands/codex-skip.md`:
```markdown
---
description: "Skip the next Codex review only"
---

# Codex Skip

Create a skip flag so the next stop does not trigger a review:

` ` `!
touch .claude/codex-collab.skip
echo "Next review will be skipped. The flag auto-clears after one use."
` ` `
```

**Step 6: Write /codex-cancel command**

Create `codex-collab/commands/codex-cancel.md`:
```markdown
---
description: "Cancel the current Codex Collab session"
---

# Codex Cancel

End the current session and clean up:

` ` `!
rm -f .claude/codex-collab.local.md
rm -f .claude/codex-collab.skip
echo "Codex Collab session cancelled. Auto-reviews disabled."
` ` `
```

**Step 7: Commit**

```bash
git add codex-collab/commands/
git commit -m "feat(codex-collab): add all slash commands (collab, status, pause, resume, skip, cancel)"
```

---

### Task 8: Skill File

**Files:**
- Create: `codex-collab/skills/codex-collab.md`

**Step 1: Write the skill**

Create `codex-collab/skills/codex-collab.md`:
```markdown
---
description: "Guides Claude's behavior during automated Codex-collaborative development sessions"
---

# Codex Collab Skill

This skill is active when a Codex Collab session is running (state file exists at `.claude/codex-collab.local.md`).

## How the Automation Works

A Stop hook automatically triggers Codex reviews. You do NOT need to manually call Codex. The workflow:

1. **DESIGNING phase:** Design/plan as normal. When you stop, the hook sends your plan to Codex.
2. **IMPLEMENTING phase:** Implement tasks one at a time. When you stop after each task, the hook sends the git diff to Codex.
3. **Feedback injection:** Codex feedback appears as a message in your context. Read it and act on it.

## Your Behavior in Each Phase

### DESIGNING
- Use brainstorming and planning workflows as normal
- Write the plan to a file under `docs/plans/`
- Update the state file's `plan_file` field: `sed -i '' "s|^plan_file: .*|plan_file: \"docs/plans/YOUR-FILE.md\"|" .claude/codex-collab.local.md`
- When done designing, simply try to stop -- the hook handles the rest

### After DESIGN_REVIEW
- You will receive Codex's design feedback as a message
- Address any CRITICAL issues by updating the plan
- Then begin implementation

### IMPLEMENTING
- Work through implementation tasks one at a time
- Commit after each task (the hook uses git diff between checkpoints)
- When you finish a task, simply try to stop -- the hook reviews your changes
- You will receive Codex's code review feedback as a message

### After TASK_REVIEW (Auto-Fix)
- Read Codex's feedback carefully
- Automatically fix CRITICAL and WARNING issues
- Show the user a brief summary: "Codex flagged [N issues]. Fixed: [list]. Continuing to next task."
- If a Codex suggestion conflicts with the approved design, flag it to the user rather than auto-fixing
- Then continue to the next task

## Escape Hatches (available to user)
- `/codex-pause` -- pause reviews
- `/codex-resume` -- resume reviews
- `/codex-skip` -- skip next review only
- `/codex-cancel` -- end session
```

**Step 2: Commit**

```bash
git add codex-collab/skills/codex-collab.md
git commit -m "feat(codex-collab): add skill file for Claude behavior guidance"
```

---

### Task 9: Integration Testing

**Files:**
- No new files; testing existing scripts

**Step 1: Test the full plugin structure**

```bash
# Verify all files exist and are executable
ls -la codex-collab/.claude-plugin/plugin.json
ls -la codex-collab/hooks/hooks.json
ls -la codex-collab/hooks/stop-hook.sh
ls -la codex-collab/scripts/*.sh
ls -la codex-collab/commands/*.md
ls -la codex-collab/skills/*.md

# Verify executables
test -x codex-collab/hooks/stop-hook.sh && echo "stop-hook.sh: OK"
test -x codex-collab/scripts/resolve-model.sh && echo "resolve-model.sh: OK"
test -x codex-collab/scripts/design-review.sh && echo "design-review.sh: OK"
test -x codex-collab/scripts/task-review.sh && echo "task-review.sh: OK"
test -x codex-collab/scripts/setup-codex-collab.sh && echo "setup-codex-collab.sh: OK"
```

**Step 2: Test model resolution**

```bash
./codex-collab/scripts/resolve-model.sh
# Expected: outputs a model name like "gpt-5.2-codex"
```

**Step 3: Test setup script**

```bash
./codex-collab/scripts/setup-codex-collab.sh "Test task for integration"
# Expected: creates .claude/codex-collab.local.md, prints activation message
cat .claude/codex-collab.local.md
# Expected: YAML frontmatter with phase: designing
```

**Step 4: Test stop hook in idle state**

```bash
# Set to idle to test no-op behavior
sed -i '' 's/^phase: .*/phase: idle/' .claude/codex-collab.local.md
echo '{}' | ./codex-collab/hooks/stop-hook.sh
echo "Exit code: $?"
# Expected: 0
```

**Step 5: Test skip flag**

```bash
sed -i '' 's/^phase: .*/phase: implementing/' .claude/codex-collab.local.md
touch .claude/codex-collab.skip
echo '{}' | ./codex-collab/hooks/stop-hook.sh
echo "Exit code: $?"
# Expected: 0 (skip flag consumed)
test ! -f .claude/codex-collab.skip && echo "Skip flag consumed: OK"
```

**Step 6: Test pause**

```bash
sed -i '' 's/^paused: .*/paused: true/' .claude/codex-collab.local.md
echo '{}' | ./codex-collab/hooks/stop-hook.sh
echo "Exit code: $?"
# Expected: 0 (paused, allowed through)
```

**Step 7: Clean up test state**

```bash
rm -f .claude/codex-collab.local.md
rm -f .claude/codex-collab.skip
rm -rf .claude/codex-collab/
```

**Step 8: Commit any fixes discovered during testing**

```bash
git add -A codex-collab/
git commit -m "test(codex-collab): verify plugin structure and hook behavior"
```

---

### Task 10: Plugin Registration & Final Verification

**Files:**
- Modify: `~/.claude/settings.json` (add plugin reference -- manual step for user)

**Step 1: Verify JSON validity**

```bash
jq . codex-collab/.claude-plugin/plugin.json
jq . codex-collab/hooks/hooks.json
```

Expected: valid JSON output for both.

**Step 2: Show user how to register the plugin**

The user needs to either:
a. Add to a marketplace/registry, or
b. Add the plugin path to their Claude Code settings

Print instructions for the user:
```
To activate the plugin, add to ~/.claude/settings.json under enabledPlugins,
or install via your preferred method.

Plugin root: /Users/varunr/projects/tools/codex-collab
```

**Step 3: Final commit**

```bash
git add -A codex-collab/
git commit -m "feat(codex-collab): complete plugin ready for registration

Automated Codex reviews for design plans and implementation tasks.
Uses Stop hook API with decision/reason/systemMessage JSON protocol."
```
