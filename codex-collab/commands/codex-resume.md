---
description: "Resume Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Resume

Resume the auto-review loop:

```!
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then echo "ERROR: No session ID."; exit 1; fi
STATE_FILE=".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.md"
if [ -f "$STATE_FILE" ]; then
  sed -i '' 's/^paused: true/paused: false/' "$STATE_FILE"
  echo "Codex Collab resumed. Auto-reviews are active again."
else
  echo "No active Codex Collab session."
fi
```
