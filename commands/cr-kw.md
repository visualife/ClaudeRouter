---
description: "ClaudeRouter: keep-warm window (short for cr-warm)"
argument-hint: "<2h|90m|off>"
disable-model-invocation: true
---
[cr-cmd] cr-kw $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-kw could not run here: the ClaudeRouter hook is not loaded" and stop.
