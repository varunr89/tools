---
description: "Check current Codex Collab session status"
---

# Codex Status

Read and display the current session state:

```!
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then echo "ERROR: No session ID."; exit 1; fi
STATE_FILE=".claude/codex-collab/sessions/${CLAUDE_SESSION_ID}.md"
if [ -f "$STATE_FILE" ]; then
  echo "=== Codex Collab Status ==="
  echo "Session: ${CLAUDE_SESSION_ID}"
  head -20 "$STATE_FILE"
  echo ""
  echo "=== Reviews ==="
  ls -la .claude/codex-collab/reviews/ 2>/dev/null || echo "No reviews yet."
else
  echo "No active Codex Collab session for this session."
fi
```
