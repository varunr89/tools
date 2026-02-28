---
description: "Skip the next Codex review only"
---

# Codex Skip

Create a skip flag so the next stop does not trigger a review:

```!
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then echo "ERROR: No session ID."; exit 1; fi
mkdir -p .claude/codex-collab/sessions
touch ".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.skip"
echo "Next review will be skipped. The flag auto-clears after one use."
```
