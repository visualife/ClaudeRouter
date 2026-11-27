---
description: "ClaudeRouter: router mode, or claude (Claude Code keeps its own model and effort)"
argument-hint: "<router|claude>"
disable-model-invocation: true
---
[cr-cmd] cr-mode $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-mode could not run here: the ClaudeRouter hook is not loaded" and stop.
