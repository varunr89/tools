---
description: "Check current Codex Collab session status"
---

# Codex Status

Read and display the current session state:

```!
if [ -f .claude/codex-collab.local.md ]; then
  echo "=== Codex Collab Status ==="
  head -20 .claude/codex-collab.local.md
  echo ""
  echo "=== Reviews ==="
  ls -la .claude/codex-collab/reviews/ 2>/dev/null || echo "No reviews yet."
else
  echo "No active Codex Collab session."
fi
```
