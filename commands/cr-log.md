---
description: "ClaudeRouter: this session's log as a table, or the previous session's"
argument-hint: "[last]"
disable-model-invocation: true
---
[cr-cmd] cr-log $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-log could not run here: the ClaudeRouter hook is not loaded" and stop.
