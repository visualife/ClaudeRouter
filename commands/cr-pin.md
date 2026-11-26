---
description: "ClaudeRouter: force a model and effort on every request, or auto"
argument-hint: "<model> [effort] | auto"
disable-model-invocation: true
---
[cr-cmd] cr-pin $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-pin could not run here: the ClaudeRouter hook is not loaded" and stop.
