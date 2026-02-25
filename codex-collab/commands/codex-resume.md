---
description: "Resume Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Resume

Resume the auto-review loop:

```!
if [ -f .claude/codex-collab.local.md ]; then
  sed -i '' 's/^paused: true/paused: false/' .claude/codex-collab.local.md
  echo "Codex Collab resumed. Auto-reviews are active again."
else
  echo "No active Codex Collab session."
fi
```
