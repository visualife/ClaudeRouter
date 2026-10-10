# ClaudeRouter

A Claude Code mod that picks the **model and effort for each request**, and keeps a live band above your prompt showing what the session is doing.

![ClaudeRouter band and /clauderouter pane](docs/screenshot.png)

## What it does

- **Routes every request** to `haiku`, `sonnet` or `opus` with a reasoning effort (`low` → `xhigh`) and a confidence score. Routing is local keyword/length/tool heuristics: no model is called to decide. A small hysteresis stops it flip-flopping between tiers.
- **Live band above the prompt**: current route, running agents, skills used, MCP calls, plugins seen, context window, and 5h / 7d plan usage.
- **`/clauderouter` pane**: cost, tokens and elapsed time cards, plus the running and finished subagents with the model and effort each one got.
- **Pixel mascots** per subagent role: scout (Explore), planner (Plan), researcher, builder.

## Install

```bash
git clone https://github.com/visualife/ClaudeRouter
```

Then add it as a local marketplace in Claude Code and install the plugin:

```
/plugin marketplace add ./ClaudeRouter
/plugin install agent-ClaudeRouter@router-mods
```

Open the pane with `/clauderouter`.

## Layout

| Path | Role |
|---|---|
| `hooks/register.ts` | Hook and command registration, state, `/clauderouter` |
| `hooks/route.ts` | Model and effort heuristics |
| `hooks/band.ts` | The band above the prompt |
| `hooks/pane.ts` | The `/clauderouter` pane |
| `hooks/pixel.ts`, `format.ts`, `lists.ts` | Sprites, formatting, list rows |
| `tests/router.test.ts` | Routing tests |

## Notes

- Built against the Claude Code mod API; type stubs are generated into `.claude-plugin/types/` (git-ignored).
- Routing is a heuristic. Check the log of what it picked before trusting it on a real task.
