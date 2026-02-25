---
description: "Pause Codex Collab auto-reviews"
allowed-tools: ["Bash(sed:*)"]
---

# Codex Pause

Pause the auto-review loop:

```!
if [ -f .claude/codex-collab.local.md ]; then
  sed -i '' 's/^paused: false/paused: true/' .claude/codex-collab.local.md
  echo "Codex Collab paused. Reviews will not trigger until you run /codex-resume."
else
  echo "No active Codex Collab session."
fi
```
