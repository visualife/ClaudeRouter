---
description: "ClaudeRouter: band above the prompt"
argument-hint: "<full|route|off>"
disable-model-invocation: true
---
[cr-cmd] cr-band $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-band could not run here: the ClaudeRouter hook is not loaded" and stop.
