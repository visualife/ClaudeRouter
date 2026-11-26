---
description: "ClaudeRouter: the agent deck as text (model, effort, who set them, tokens, cost)"
argument-hint: "[last]"
disable-model-invocation: true
---
[cr-cmd] cr-deck $ARGUMENTS

Print the ClaudeRouter reply that replaces this text verbatim and do nothing else. If you still see the "[cr-cmd]" line above, the ClaudeRouter hook did not run in this session: say "/cr-deck could not run here: the ClaudeRouter hook is not loaded" and stop.
