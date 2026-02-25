# Codex Collab Plugin Design

**Date:** 2026-02-25
**Status:** Approved

## Problem

The phone-a-friend skill requires manual invocation to consult Codex. We want an automated workflow where Codex reviews designs and implementation tasks seamlessly, without manual prodding.

## Solution

A Claude Code plugin called **codex-collab** that uses Stop hooks to automatically trigger Codex reviews at two key points:
1. **After design completion** -- Codex reviews the design plan before implementation starts
2. **After each implementation task** -- Codex reviews the code changes for each task, Claude auto-fixes issues

## Architecture

### State Machine

```
IDLE  --(/codex-collab)--> DESIGNING
DESIGNING  --(stop hook)--> DESIGN_REVIEW
DESIGN_REVIEW  --(feedback incorporated)--> IMPLEMENTING
IMPLEMENTING  --(stop hook per task)--> TASK_REVIEW
TASK_REVIEW  --(auto-fix applied)--> IMPLEMENTING (next task)
IMPLEMENTING  --(all tasks done)--> COMPLETE
COMPLETE  --(cleanup)--> IDLE
```

### State File

Location: `.claude/codex-collab.state.json`

```json
{
  "phase": "implementing",
  "task_index": 2,
  "total_tasks": 5,
  "codex_session_id": "019a60d1-fb72-7e52...",
  "git_checkpoint": "abc123de",
  "review_log": "reviews/task-2-review-20260225-143022.md",
  "last_transition": "2026-02-25T14:30:22Z",
  "paused": false,
  "cached_model": "gpt-5.2-codex",
  "model_cached_at": "2026-02-25T14:00:00Z"
}
```

### Plugin File Structure

```
codex-collab/
  plugin.json              # Manifest
  commands/
    codex-collab.md        # /codex-collab -- start a collab session
    codex-status.md        # /codex-status -- check state/progress
    codex-pause.md         # /codex-pause -- pause auto-review
    codex-resume.md        # /codex-resume -- resume auto-review
    codex-skip.md          # /codex-skip -- skip next review only
    codex-cancel.md        # /codex-cancel -- end session entirely
  hooks/
    hooks.json             # Stop hook registration
    stop-hook.sh           # Lifecycle engine (state machine)
  skills/
    codex-collab.md        # Skill: how Claude should behave in each phase
  scripts/
    design-review.sh       # Sends design to Codex, captures feedback
    task-review.sh         # Sends task diff to Codex, captures feedback
    resolve-model.sh       # Discovers and caches latest codex model
```

## Stop Hook -- The Core Automation Engine

The Stop hook fires every time Claude tries to end its turn. The hook script (`stop-hook.sh`) reads the state file and decides what to do.

### Hook Registration

`hooks/hooks.json`:
```json
{
  "hooks": [
    {
      "type": "command",
      "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh",
      "event": "Stop",
      "timeout": 900
    }
  ]
}
```

### Stop Hook Logic

```
Read state from .claude/codex-collab.state.json

# Escape hatches (checked first)
if state.paused == true: exit 0 (allow stop)
if .claude/codex-collab.skip exists: delete flag, exit 0

Case state.phase:
  "idle" ->
    Exit 0 (allow stop, no active session)

  "designing" ->
    Transition phase to "design_review"
    Run design-review.sh
    Write feedback to reviews/design-review-<timestamp>.md
    Print feedback summary to stdout (Claude sees this)
    Transition phase to "implementing"
    Exit 1 (block stop -- Claude sees feedback and continues)

  "implementing" ->
    Get git diff from state.git_checkpoint to HEAD
    If diff is empty: exit 0 (no changes, allow stop)
    Transition phase to "task_review"
    Run task-review.sh with the diff
    Write review to reviews/task-<N>-review-<timestamp>.md
    Print review summary to stdout
    Update git_checkpoint to current HEAD
    Increment task_index
    Transition phase back to "implementing"
    Exit 1 (block stop -- Claude sees review and auto-fixes)

  "complete" ->
    Clean up state file
    Exit 0 (allow stop)
```

### Key Mechanism

When the hook exits non-zero, Claude Code sees the stdout output and continues working. This is how Codex feedback gets injected back into Claude's context without any manual intervention.

### Git Checkpoint Tracking

After each review, the script stores the current HEAD SHA in the state file. The next task review diffs only from that checkpoint, so Codex sees only the changes for the current task.

## Escape Hatches

| Command | Behavior |
|---|---|
| `/codex-pause` | Sets `paused: true` in state. Hook allows all stops. |
| `/codex-resume` | Sets `paused: false`. Reviews resume. |
| `/codex-skip` | Creates `.claude/codex-collab.skip` flag. Hook deletes it and allows one stop. |
| `/codex-cancel` | Deletes state file entirely. Session ends. |

## Codex Model & Reasoning Configuration

### Model Resolution (Cached Per Session)

- On first Codex call in a session, run `resolve-model.sh`
- Queries `codex config get model`, filters for `-codex` variants
- Caches result in state file (`cached_model`, `model_cached_at`)
- All subsequent calls use cached model (zero per-call overhead)
- User can override via `.claude/codex-collab.local.md` frontmatter:
  ```yaml
  ---
  model: gpt-5.3-codex  # Pin to specific model
  ---
  ```

### Reasoning Level Selection

Floor is `high`. Never use `medium` or `low`.

| Condition | Reasoning |
|---|---|
| Design review | `extra-high` (always) |
| Task review: security files, >200 line diff, architecture changes | `extra-high` |
| Task review: normal implementation | `high` |

Security file detection:
```bash
git diff --name-only "$CHECKPOINT"..HEAD | grep -iE 'auth|crypto|secret|security|\.key|\.pem|password|token'
```

User override via `.claude/codex-collab.local.md`:
```yaml
---
reasoning_override: extra-high  # Force all reviews to extra-high
---
```

## Review Scripts

### design-review.sh

Inputs: path to design plan file
Process:
1. Read design plan content
2. Read cached model from state (or resolve if not cached)
3. Determine reasoning level (always `extra-high` for design)
4. Send to Codex:
   ```bash
   cat <<'EOF' | codex exec \
     -c model=$MODEL \
     -c model_reasoning_effort=extra-high \
     -c 'sandbox_permissions=["disk-read-access"]' \
     -c approval=never -c full_auto=true
   Review this design plan for:
   - Completeness: are there missing components or edge cases?
   - Performance implications: will this scale?
   - Security concerns: any attack vectors?
   - Maintainability: will this be easy to change later?
   - Simplicity: is anything over-engineered?

   Be specific. List issues with severity (critical/warning/info).

   Design plan:
   [plan content]
   EOF
   ```
5. Parse response, write to reviews/ directory
6. Print summary to stdout

### task-review.sh

Inputs: git checkpoint SHA, task description
Process:
1. Get diff: `git diff $CHECKPOINT..HEAD`
2. Get list of changed files
3. Read cached model from state
4. Determine reasoning (high or extra-high based on context)
5. Send to Codex:
   ```bash
   cat <<'EOF' | codex exec \
     -c model=$MODEL \
     -c model_reasoning_effort=$REASONING \
     -c 'sandbox_permissions=["disk-read-access"]' \
     -c approval=never -c full_auto=true
   Review these code changes for:
   - Correctness and potential bugs
   - Performance and maintainability
   - Adherence to best practices
   - Edge cases and error handling

   Provide specific feedback with file:line references.
   Format: SEVERITY: FILE:LINE - description

   Task: [task description]
   Changed files: [list]
   Diff:
   [diff content]
   EOF
   ```
6. Parse response, write to reviews/ directory
7. Print summary to stdout

## Skill: How Claude Behaves

The skill (`skills/codex-collab.md`) instructs Claude on behavior in each phase:

- **DESIGNING phase:** Work normally (brainstorming, writing plans). When design is finalized, update state phase to `designing` and attempt to stop (triggers hook).
- **IMPLEMENTING phase:** Work through tasks one at a time. After completing each task, attempt to stop (triggers hook). When review feedback comes back via stdout, automatically incorporate feedback and show user a summary: "Codex flagged [N issues]. Fixed: [list]. Continuing to next task."
- **Auto-fix behavior:** Read review output, make fixes, then continue. If a Codex suggestion conflicts with the approved design, flag it to the user rather than auto-fixing.

## Review Output Format

Reviews are saved to `.claude/codex-collab/reviews/`:
```
reviews/
  design-review-20260225-143022.md
  task-1-review-20260225-150100.md
  task-2-review-20260225-153045.md
  ...
```

Each review file:
```markdown
---
type: task_review
task_index: 2
model: gpt-5.2-codex
reasoning: high
timestamp: 2026-02-25T15:30:45Z
files_reviewed: ["src/auth.ts", "src/middleware.ts"]
lines_changed: 85
issues_found: 3
---

# Task 2 Review

## Issues

### CRITICAL: src/auth.ts:45
Missing input validation on user-supplied token.

### WARNING: src/middleware.ts:23
Synchronous file read in request handler will block event loop.

### INFO: src/auth.ts:67
Consider extracting token parsing to a shared utility.

## Summary
3 issues found (1 critical, 1 warning, 1 info).
```

## Dependencies

- Codex CLI installed (`codex` command available)
- `Bash(codex:*)` pre-approved in Claude Code settings (already configured)
- Git repository (for diff-based reviews)

## References

- [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) -- Stop hook pattern for Codex review automation
- [Claude-Codex iterative plan review](https://aseemshrey.in/blog/claude-codex-iterative-plan-review/) -- Session resume pattern for multi-turn reviews
- [claude_code_bridge](https://github.com/bfly123/claude_code_bridge) -- Multi-AI collaboration architecture
- [Peter Steinberger's workflow](https://steipete.me/posts/just-talk-to-it) -- Parallel agent orchestration patterns
