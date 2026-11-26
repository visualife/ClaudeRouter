---
description: "ClaudeRouter: context size limit, or off"
argument-hint: "<150k|off>"
disable-model-invocation: true
---
[cr-cmd] cr-ctx $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-ctx could not run here: the ClaudeRouter hook is not loaded" and stop.
