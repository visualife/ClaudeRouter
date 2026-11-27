---
description: "ClaudeRouter: one Sonnet agent reviews the last n session logs (default 10)"
argument-hint: "[n]"
disable-model-invocation: true
---
[cr-cmd] cr-review $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-review could not run here: the ClaudeRouter hook is not loaded" and stop.
