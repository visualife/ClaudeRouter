---
description: "ClaudeRouter: leave a model alone (no rerouting, no caps)"
argument-hint: "<model|all|none>"
disable-model-invocation: true
---
[cr-cmd] cr-lock $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-lock could not run here: the ClaudeRouter hook is not loaded" and stop.
