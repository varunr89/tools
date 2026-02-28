---
description: "Pause Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Pause

Pause the auto-review loop:

```!
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then echo "ERROR: No session ID."; exit 1; fi
STATE_FILE=".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.md"
if [ -f "$STATE_FILE" ]; then
  sed -i '' 's/^paused: false/paused: true/' "$STATE_FILE"
  echo "Codex Collab paused. Reviews will not trigger until you run /codex-resume."
else
  echo "No active Codex Collab session."
fi
```
