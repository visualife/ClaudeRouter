# ClaudeRouter

A Claude Code mod that picks the **model and effort for each request**, and keeps a live band above your prompt showing what the session is doing.

![ClaudeRouter band above the prompt: model route, task bars, skills, MCP, context, 5h / 7d and Fable usage, keep-warm](docs/screenshot.png)

## What it does

- **Routes every request** to `haiku`, `sonnet` or `opus` with a reasoning effort (`low` → `xhigh`) and a confidence score. Routing is local keyword/length/tool heuristics: no model is called to decide. A small hysteresis stops it flip-flopping between tiers.
- **Live band above the prompt**: current route, running agents, skills used, MCP calls, plugins seen, context window, and 5h / 7d plan usage.
- **`/clauderouter` pane**: cost, tokens and elapsed time cards, plus the running and finished subagents with the model and effort each one got.
- **Jev as the router (optional)**: let [Jev](https://typesafe.ai) (TypeSafe System One) pick the tier instead of the keyword rules. Falls back to the rules on any error or timeout.
- **Keep the cache warm (optional)**: pings the prompt cache every 50 minutes while you are idle, so a break does not cost a full re-write.
- **Pixel mascots** per subagent role: scout (Explore), planner (Plan), researcher, builder.

## Cost guards (v0.4)

Applied on every model request, after the router (or Jev) has picked. Defaults protect your plan; change them with `/clauderouter`.

| Guard | Default | Effect |
|---|---|---|
| Effort ceiling | `high` | `xhigh` is never picked automatically. `/clauderouter cap medium` to lower it. |
| Opus plans, Sonnet executes | first 2 requests | After that, or once the turn writes files / runs 6+ tools, the turn moves to Sonnet (medium). |
| Long spec | > 1200 chars | Opus never runs above medium on it. |
| Subagents | not Opus | Only `Plan` subagents may use Opus; all others capped at medium. |
| Turn budget | $3 per turn | Over it: Sonnet medium. Over 2×: Sonnet low. A toast tells you. `/clauderouter budget 5` or `off`. |
| Context cap | 150k tokens | Over it: Sonnet medium. Over 1.5×: Sonnet low. `/clauderouter ctx 200k` or `off`. |
| Haiku and big contexts | 100k tokens | Above it the main thread never moves to Haiku: a light request stays on Sonnet at low effort. Subagents are not concerned. |
| Your choice wins | none | `/clauderouter pin sonnet medium` applies from the **next request, even mid-turn**. `pin auto` releases it. Or prefix one prompt: `@sonnet:med build the app` / `@opus:high ...`. |
| Model locks | `fable` | A session on a locked model is left alone, subagents included. See **Model locks**. |
| Creative work stays strong | on | Copywriting, art direction and brand work get their own tiers, by case (see **Creative work**). They keep their model for the whole turn: no plan/execute split, no long-prompt cap, and their own effort ceiling (`xhigh`). Over the budget or context cap the model drops to Sonnet, but the effort stays high. Creative subagents run on Sonnet at high effort. Your pin and locks still win. |

The band's second line shows `guard ...` with the reason whenever a limit changed the pick, and is hidden otherwise. Budget uses the session cost the engine reports (API-equivalent USD).

## Agent roster (v0.4.5)

The plugin ships three subagents in `agents/`: `planner` (Opus, read-only, returns a plan), `implementer` (Sonnet) and `reviewer` (Sonnet, one pass with a checklist). A subagent type named `Plan`, `planner` or `architect` (also as `agent-ClaudeRouter:planner`) is the only kind that may run on Opus, at `xhigh`; every other subagent stays on Sonnet or Haiku. For test, lint and build runs, keep a Haiku `test-runner` agent of your own: the router already sends runner-named types to Haiku.

## Routing fixes (v0.4.4)

- **A nudge carries on.** A prompt under 60 characters with no keyword ("yes go ahead", "oui vas-y", "continue") keeps the model and effort the previous turn ended on. It used to score as a short light request, so the turn that ran an approved plan started on Haiku at low effort.
- **French prompts are scored.** The heavy / mid / light lists have French forms (`planifie`, `débogue`, `corrige`, `ajoute`, `mets à jour`, `liste`, `où`...). Before, a French code prompt matched nothing and ran on Sonnet at low effort.
- **Sonnet runs at medium**, its stock effort. Low is kept for a prompt that reads as a lookup and nothing else.
- **Everyday words count for half when alone**: `design`, `system`, `why`, `across`, `race`, `performance`, `optimize`. "update the design system tokens in the css file" stays on Sonnet; "debug why the token check fails" is still Opus.
- **Runner subagents go to Haiku.** A subagent type with `runner`, `lint` / `linter` or `format` / `formatter` as a name part (`test-runner`) outweighs the "test" and "build" in its own brief.
- **No Haiku above 100k tokens on the main thread.** Haiku 5.5 bills a prompt over 100k tokens at five times its base rates, and a model switch re-reads the whole context uncached. The band shows `guard haiku>100k`.
- **Jev is asked once per turn** per thread (the main conversation, each subagent), not before every model request, and not at all about a prompt that only carries on. A failed call is not retried until the next turn.
- The context-cap toast names the cheaper fix: `/compact`, or `/clear` between tasks.
- "affiche les fichiers" (the French verb) is no longer read as a poster brief.

## Creative work (v0.4.3)

Copywriting, art direction and brand work are judged on taste and voice, not speed, so the router gives them a stronger model and more effort than code of the same length. The case decides how much:

| Case | Examples (EN / FR) | Model / effort |
|---|---|---|
| **Flagship**: work a brand lives with | brand identity, naming, tagline, slogan, manifesto, value proposition, art direction / direction artistique, creative brief, moodboard, key visual, campaign concept, logo concept, color palette, font pairing, video script, storyboard, design critique | **Opus `xhigh`**, or **Fable `high`** with `/clauderouter creative fable` |
| **Craft**: everyday copy and visual briefs | landing page, product description / fiche produit, newsletter, subject lines, captions, social posts, blog post, press release, image prompts (Midjourney, Magnific, Flux), photo brief, poster, flyer | **Opus `high`** |
| **Bulk**: volume or adaptation | a whole catalogue or CSV of product sheets, translations / traductions, meta descriptions, alt text, SEO titles | **Sonnet `high`** |

- Volume turns craft into bulk. It turns flagship into craft, not bulk: a translated manifesto still needs care.
- Creative turns use `creativeCap` (default `xhigh`) as their ceiling instead of `cap`. `/clauderouter creative cap high` lowers it.
- Fable is opt-in: `/clauderouter creative fable` sends flagship work to Fable 5.2 at `high` (Anthropic's recommended default for it), and craft and bulk stay where they are. Each flagship turn then draws on your weekly Fable allowance. A session the router moved to Fable is not frozen there by the Fable lock: the lock only holds a model *you* chose.
- `/clauderouter creative off` routes creative prompts like any other.
- Bare "copy", "design", "script", "naming" and "positionnement" are not creative signals on purpose: "copy the file", "naming conventions", "a bash script" and CSS positioning stay code.
- When the guard kept the model for a creative turn, the band's second line shows `guard flagship: strong` (or `craft`, `bulk`). The keyword that made the turn creative (`kw:creative`, `kw:copy`) is no longer echoed on the band.

## Model locks (v0.4.1)

A lock tells the router to leave a model alone. When the session runs on a locked model, every request keeps the model and effort it arrived with: no rerouting, no budget or context downgrade. The band shows `<model> lock`. Fable is locked by default; the router never picks Fable by itself.

- `/clauderouter lock opus` locks a model, `/clauderouter unlock opus` releases it. `lock all` / `lock none` for every model. `/clauderouter status` lists what is locked.
- **Subagents stay locked too.** A subagent spawned from a locked session that names no model inherits the session's model and keeps it on every request, until you unlock. A subagent whose Agent call names a model always keeps that model.
- A model id the router does not know is never rewritten (it used to become Sonnet).
- A pin (`/clauderouter pin <model>`) or an `@model` prompt prefix still wins over a lock.
- `/clauderouter fable lock` and `fable auto` from 0.4.1 still work; they mean `lock fable` and `unlock fable`.
- **What went wrong before:** the router only knew haiku, sonnet and opus. A Fable id matched none of them, so each request, main thread and subagents alike, was rewritten to `claude-sonnet-5-5` or `claude-haiku-5-5`, and the band said "switched". Ids are now looked up in `MODEL_IDS` instead of swapping a word in the running id.

## Dashboard pane (v0.4.2)

The full dashboard is the `/clauderouter` pane: cost, tokens and time, skills, MCP, plugins, context, 5h / 7d usage, the **Keep warm** clock (time left in the window and the countdown to the next ping), and the running and finished agents. It opens at session start, 24 rows tall. Drag or resize it with the engine's pane controls, or dock it beside the chat on a wide terminal, so it does not cover the conversation. The band above the prompt shows every row again (route, agents, skills, MCP, plugins, context, 5h / 7d, keep-warm). Claude Code places and sizes that band, so a mod cannot make it draggable; only the pane drags. To keep the chat clear, `/clauderouter band route` shrinks the band to the **task bar** (● task name, a bar with a `Tasks 2/4` pill, the percent, a small crab and the agent count) over the model route line, and `/clauderouter band full` brings every row back. Claude Code's own collapse (`[-]`, ctrl+x ctrl+a) also works on it.

**Bars show real values and never move.** Every bar is one text line tall, like the Savvy Progress reference, and holds a 4-row dot matrix: each cell is a braille character (a 2 x 4 grid of dots) with a fixed random subset lit, the same texture on every bar. The filled part shows it in the accent, the part still ahead shows the same dots very dim, so a fill reads as the texture being revealed. The terminal draws it as a one-row Raster, the desktop as Text runs. The fill is the measured share: context, 5h and 7d are their percent; a task is its finished subagents over all of them; a pane row is its share of the session's tokens. No reading yet means an all-dim bar. Opacity is eased, not linear: the fill is dim at its tail and brightens toward the leading edge on a power curve, and the track ahead fades out on a smoothstep. The `Tasks 2/4` capsule sits at the edge of the fill (left at 0%, moving right as it grows). The Jev chip is pink. The small crab beside the percent is the reference crab (eyes, side arms, four legs): a Raster in the terminal, one line of five braille characters on the desktop, the height of the text beside it.

**Fable usage bar.** The band and the pane have a `Fable · session` row: the share of this session's tokens that ran on Fable. Claude Code reports only the 5h and 7d windows (and a gateway spend limit), not how much of the weekly limit went to Fable, so the plan's 50% Fable cap cannot be read from here. If the engine ever reports a window that names Fable, the row shows that reading as `Fable · plan` instead.

## Models (v0.4.2)

| Family | Id the router uses | Auto-picked | Notes |
|---|---|---|---|
| `haiku` | `claude-haiku-5-5` | yes | Light reads, searches, subagents of type Explore. |
| `sonnet` | `claude-sonnet-5-5` | yes | Default for building and executing. |
| `opus` | `claude-opus-5-5` | yes | Planning, flagship creative work (`xhigh`) and craft copy (`high`). |
| `fable` | `claude-fable-5-2` | only with `creative fable` | Locked by default. A session already on Fable 5.1 or 5 keeps its own id; `claude-fable-5-2` is only used when you pin or switch into Fable. |

**Fable and your plan** (per [Anthropic's help page](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan), checked 2026-11-09): Fable 5, 5.1 and 5.2 are on all paid plans. Max, Ultra and premium Team/Enterprise seats include Fable in the plan, up to 50% of the weekly limit; Pro and standard seats run Fable on usage credits. The page gives no end date for the plan inclusion; the one dated promotion (Fable 5 only) ended 2026-07-19. Claude Code minimums: Fable 5.2 needs 2.1.321, 5.1 needs 2.1.255. That is why Fable stays locked and is never picked automatically: it eats the weekly limit faster than the other models.

## Claude desktop

The mod is surface-aware: the band and pane already draw with plain `Text` bars on `desktop` (no Raster), and the tests cover both surfaces. Claude desktop's Code tab runs the same Claude Code engine, so install it there with the same two commands:

```
/plugin marketplace add C:\Users\studi.REAL\Documents\GitHub\ClaudeRouter
/plugin install agent-ClaudeRouter@router-mods
/reload-plugins
```

Install at user scope so the CLI and the desktop Code tab share it. Chat and Cowork tabs do not run mods.

## Requirements

- A Claude Code build that supports mods (plugins that ship `hooks/*.ts` modules and a `types` entry).
- Git, to clone the repo.

## Install

1. Clone the repo anywhere on your machine:

   ```bash
   git clone https://github.com/visualife/ClaudeRouter
   ```

2. In Claude Code, add the clone as a local marketplace and install the plugin:

   ```
   /plugin marketplace add ./ClaudeRouter
   /plugin install agent-ClaudeRouter@router-mods
   ```

   Use the full path to the clone if it is not in the directory you launched Claude Code from.

3. Reload plugins (`/reload-plugins`) or restart Claude Code. The band appears above the prompt.

## Usage

- **Band**: shows automatically. It updates on every prompt with the picked model, effort and confidence, and tells you when it switched model.
- **Pane**: type `/clauderouter` to open it. Press `Esc` to close.
- **Subagents**: each one appears in the pane's *Running* and *Finished* lists with its own model and effort.

## Options

Set them from the prompt; they persist across reloads.

| Command | Effect |
|---|---|
| `/clauderouter engine jev` | Jev picks haiku / sonnet / opus. Needs `TYPESAFE_API_KEY` in the environment. |
| `/clauderouter engine rules` | Local keyword rules (default). |
| `/clauderouter warm 2h` | Keep the prompt cache warm for 2h (default 2h, max 6h). |
| `/clauderouter warm off` | Stop. |
| `/clauderouter pin <model> [effort]` / `pin auto` | Force a model (and effort), effective next request. |
| `/clauderouter lock <model\|all\|none>` / `unlock <model\|all>` | Leave a model alone (no rerouting, no caps), subagents included. Fable is locked by default. |
| `/clauderouter cap <effort>` | Highest effort the router may pick. |
| `/clauderouter budget <usd\|off>` | Per-turn spend limit. |
| `/clauderouter ctx <150k\|off>` | Context size limit. |
| `/clauderouter band <full\|route\|off>` | Band above the prompt: every row, only the task bar and the model route, or closed. The band also has a close control (✕ in the terminal, the native close mark on the desktop) that sets `off`; `band full` brings it back. The pane is separate and stays open. |
| `/clauderouter creative <opus\|fable\|off>` | Where flagship creative work goes: Opus `xhigh` (default), Fable `high`, or no creative routing. |
| `/clauderouter creative cap <effort>` | Highest effort creative work may run at (default `xhigh`). |
| `/clauderouter status` | Show the current options. |

**Jev**: it only chooses the tier; Claude still does the work. Each turn sends the prompt text (first 4000 characters) to `api.typesafe.ai` once per thread, the main conversation and each subagent, and costs one small Jev call (about 0.3 s); the following requests of the turn reuse the answer. In the band, `jev` sits beside `haiku sonnet opus` on the Model route row: lit when Jev made the pick, dim when the rules did. Once Jev has been used, a `Jev · context` bar appears: the last call's input tokens against Jev's 64k per-request window, with the call count. A Jev pick shows `jev` on the band's second line (the line is otherwise hidden unless a guard limit applied). With no key, an error or a 2.5 s timeout, the rules decide, so nothing blocks.

**Keep warm**: each ping is a short model call on the existing conversation (cache reads, cheap). It only runs while the window is open and no turn is running, and it ends the window if a ping fails, since the cache is then probably gone. Switching model tiers loses the cache of the previous tier, which is what this is for. If you already run the `cache-tax` mod's `/keepwarm`, use one of the two, not both.

## Update / uninstall

```bash
git -C ClaudeRouter pull
```

```
/plugin uninstall agent-ClaudeRouter@router-mods
/plugin marketplace remove router-mods
```

## Tuning

Routing lives in `hooks/route.ts`: edit the `HEAVY`, `HEAVY_WEAK`, `MID` and `LIGHT` keyword lists (and their `_FR` twins), or `HYSTERESIS`, to change how eagerly it moves between tiers.

## Layout

| Path | Role |
|---|---|
| `hooks/register.ts` | Hook and command registration, state, `/clauderouter` |
| `hooks/route.ts` | Model and effort heuristics |
| `hooks/guard.ts` | Cost guards: effort ceiling, plan/execute split, budget, context cap, pin |
| `hooks/band.ts` | The band above the prompt |
| `hooks/pane.ts` | The `/clauderouter` pane |
| `hooks/pixel.ts`, `format.ts`, `lists.ts` | Sprites, formatting, list rows |
| `tests/router.test.ts` | Routing tests |
| `tests/copy.test.ts` | Creative cases, floor, guard and `creative` options |

## Notes

- Built against the Claude Code mod API; type stubs are generated into `.claude-plugin/types/` (git-ignored).
- Routing is a heuristic. Check the log of what it picked before trusting it on a real task.
