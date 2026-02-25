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
