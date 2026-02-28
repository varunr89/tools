---
description: "Cancel the current Codex Collab session"
---

# Codex Cancel

End the current session and clean up:

```!
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then echo "ERROR: No session ID."; exit 1; fi
rm -f ".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.md"
rm -f ".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.skip"
echo "Codex Collab session cancelled. Auto-reviews disabled."
```
