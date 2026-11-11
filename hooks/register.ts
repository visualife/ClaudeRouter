import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Agent, Effort, Model, Route, Task } from '../types'
import { JEV_TIMEOUT_MS, askJev } from './jev'
import { DEFAULT_OPTIONS, WARM_EVERY_MS, applyArgs, normalize } from './options'
import { EFFORTS, type Pin, directiveOf, guard } from './guard'
import { type Els, type Snapshot, drawBand, drawStrip } from './band'
import { drawPane } from './pane'
import { type Anim, animCells } from './pixel'
import { creativeFloor, creativeOf, effortFor, familyOf, idFor, pickRoute, roleOf } from './route'
import { attachAgent, addPlugin, bumpMcp, bumpSkill, nameOf, patchAgent, patchTask, toUsage } from './lists'

const PANE = 'agent-ClaudeRouter'

// The values ClaudeRouter draws, kept in $.state. A write redraws the sites that read it.
// Declared here, beside their writes: the state scan reads each atom where it is written.
const route = atom({ plugin: 'agent-ClaudeRouter', key: 'route' } as const, null)
const tasks = atom({ plugin: 'agent-ClaudeRouter', key: 'tasks' } as const, [])
const skills = atom({ plugin: 'agent-ClaudeRouter', key: 'skills' } as const, [])
const mcp = atom({ plugin: 'agent-ClaudeRouter', key: 'mcp' } as const, [])
const plugins = atom({ plugin: 'agent-ClaudeRouter', key: 'plugins' } as const, [])
const usage = atom({ plugin: 'agent-ClaudeRouter', key: 'usage' } as const, null)
const jev = atom({ plugin: 'agent-ClaudeRouter', key: 'jev' } as const, null)
const options = atom({ plugin: 'agent-ClaudeRouter', key: 'options' } as const, DEFAULT_OPTIONS)
const totals = atom({ plugin: 'agent-ClaudeRouter', key: 'totals' } as const, { tokens: 0, turns: 0 })

// Shared by the hooks below. A reload starts them over; $.state keeps what the band shows.
let busy = false
let frame = 0
let terminal = false
let turnId = ''
let turnText = ''
let turnTools: string[] = []
// Cost guards: the session cost when this turn began, a "@model:effort" prompt prefix, and one warning per turn
let turnCostStart = 0
let turnPin: Pin | null = null
let warned = false
// The locked model id the router itself last sent on the main thread (Fable for flagship creative work, when
// /clauderouter creative fable is on). A request arriving on that id is the router's own choice, not the user's,
// so the lock does not freeze it there.
let routedLocked: string | null = null
// When the main thread last sent a request, for keep-warm
let lastRequestAt: number | null = null
// explicit: the Agent call named a model. Its requests are then passed through untouched.
const subagents = new Map<string, { text: string; subagentType?: string; explicit: boolean }>()
// The Rasters each drawn site mounted that shimmer or move: what the timer repaints with $.ui.blit
const mounted = new Map<string, Anim[]>()

// Gathers what a drawing reads. The validator follows $ only into functions declared at the top of the file.
async function snapshot($: EngineInterface, surface: string, columns: number, rows: number): Promise<Snapshot> {
  const now = await $.clock.now()
  const { warmUntil } = normalize(await read($, options))
  return {
    warm: warmUntil > now ? { until: warmUntil, pingAt: lastRequestAt === null ? null : lastRequestAt + WARM_EVERY_MS } : null,
    route: await read($, route),
    tasks: await read($, tasks),
    skills: await read($, skills),
    mcp: await read($, mcp),
    plugins: await read($, plugins),
    usage: await read($, usage),
    jev: await read($, jev),
    totals: await read($, totals),
    now,
    frame,
    terminal: surface === 'terminal',
    columns,
    rows,
    anim: [],
  }
}

export const register: Register = on => {
  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clauderouter',
      description: 'Open ClaudeRouter: cost, tokens, time, running and finished agents',
      immediate: true,
    })
    // The dashboard opens as a pane, taller than the default and draggable by the person; the band above the prompt keeps the route only
    void $.ui.open({ id: PANE, title: 'ClaudeRouter', rows: 24, closeOnEscape: true }).catch(() => undefined)
    const raw = await $.session.usage()
    await update($, usage, () => toUsage(raw))
    // Ten frames a second, and only while a turn is running
    $.clock.every(100, async () => {
      if (!busy) return
      frame += 1
      if (!terminal) {
        // The desktop has no Raster: its Text bars are redrawn
        $.ui.invalidate('ui.render')
        return
      }
      for (const [requestId, list] of mounted) {
        for (const a of list) {
          if (frame % 4 !== 0) continue
          await $.ui.blit({ requestId, key: a.key, cells: animCells(a, frame) })
        }
      }
      // The seconds counters are Text, which a blit does not reach: redraw once a second
      if (frame % 10 === 0) $.ui.invalidate('ui.render')
    })
    // Keep-warm: once a minute, ping the cache if the window is open and the main thread has been idle for 50 min
    $.clock.every(60_000, async () => {
      const now = await $.clock.now()
      const { warmUntil } = await read($, options)
      // The clock row counts in minutes: redraw once a minute while a window is open
      if (warmUntil > now) $.ui.invalidate('ui.render')
      if (warmUntil <= now || busy || lastRequestAt === null || now - lastRequestAt < WARM_EVERY_MS) return
      const reply = await $.model.fork({ prompt: 'Reply with the single word: warm' }).catch(() => null)
      // A failed ping ends the window: the cache is probably gone, and retrying would only pay to write it again
      if (!reply || !reply.isAnswered) await update($, options, o => ({ ...o, warmUntil: 0 }))
      else lastRequestAt = now
    })
    return next(e)
  })

  // Runs when you type /ClaudeRouter. Opening the pane draws nothing by itself; ui.render fills it.
  on('command.run', { command: 'clauderouter' }, async ($, e) => {
    if (e.args.trim()) {
      const now = await $.clock.now()
      const { next, text } = applyArgs(e.args, normalize(await read($, options)), now)
      if (next) await update($, options, () => next)
      return { text }
    }
    await $.ui.open({ id: PANE, title: 'ClaudeRouter', rows: 24, closeOnEscape: true })
    return {}
  })

  // Runs when a turn begins: a new task row, named by the prompt
  on('turn.start', async ($, e, next) => {
    busy = true
    turnId = e.turnId
    turnText = e.text
    turnTools = []
    turnPin = directiveOf(e.text)
    warned = false
    turnCostStart = (await read($, usage))?.cost ?? 0
    const task: Task = {
      id: e.turnId,
      name: nameOf(e.text),
      status: 'running',
      startedAt: await $.clock.now(),
      seconds: null,
      steps: 0,
      model: null,
      effort: null,
      tokens: null,
      agents: [],
    }
    await update($, tasks, list => [...list.slice(-19), task])
    return next(e)
  })

  // Runs before each request to the model: picks the model and effort, then records what was chosen
  on('turn.step', async function* ($, e, next) {
    const sub = e.agentId ? subagents.get(e.agentId) : undefined
    // Options saved by an older version lack the guard fields, or carry the old fableLock flag: normalize fills them in
    const opts = normalize(await read($, options))
    const input = {
      text: e.agentId ? (sub?.text ?? '') : turnText,
      tools: e.agentId ? [] : turnTools,
      subagentType: sub?.subagentType,
      current: familyOf(e.model),
      creative: opts.creative,
    }
    let pick = pickRoute(input)
    let by: Route['by'] = 'rules'
    if (!e.agentId) lastRequestAt = await $.clock.now()
    // Pass-through: the request keeps the model and effort it arrived with, and the band says why.
    //  - model lock: a main-thread session on a locked model (Fable by default), or on an id the router does not
    //    know, is left alone, unless a pin or an "@model" prefix says otherwise. Without this, the router did not
    //    know Fable and rewrote every request to Sonnet or Haiku.
    //  - a subagent whose Agent call named a model: that choice was explicit, so the router never overrides it.
    const family = familyOf(e.model)
    const lockMain = !e.agentId && (family === null || opts.locks.includes(family)) && !turnPin && !opts.pin && e.model !== routedLocked
    // A subagent is left alone when its Agent call named a model, when it inherited a locked parent's model, or
    // when the model it runs on is itself locked
    const lockSub = Boolean(e.agentId) && (sub?.explicit === true || (family !== null && opts.locks.includes(family)))
    if (lockMain || lockSub) {
      const eff: Effort = EFFORTS.includes(e.effort as Effort) ? (e.effort as Effort) : 'high'
      const shown: Model = family ?? 'fable'
      const passed = yield* next(e)
      const why = lockSub
        ? (sub?.explicit ? 'agent keeps the model it was given · left as it is' : `${family} lock · agent left as it is`)
        : `${family ?? 'unknown model'} lock · your model choice is left as it is`
      const locked: Route = { model: shown, effort: eff, conf: 1, kept: true, by: 'rules', engineModel: e.model, source: e.agentId ? 'subagent' : 'main', why }
      await update($, route, () => locked)
      if (e.agentId) {
        const agentId = e.agentId
        await update($, tasks, list => patchAgent(list, agentId, { model: shown, effort: eff }))
      } else {
        const lockedTurn = e.turnId
        await update($, tasks, list => patchTask(list, lockedTurn, { steps: e.index + 1, model: shown, effort: eff }))
      }
      return passed
    }
    if (opts.engine === 'jev') {
      const key = await $.env.get('TYPESAFE_API_KEY')
      const timeout = new Promise<null>(resolve => { $.clock.after(JEV_TIMEOUT_MS, () => resolve(null)) })
      const asked = key ? await Promise.race([askJev((url, init) => $.http.fetch(url, init), key, input), timeout]) : null
      if (asked) {
        pick = { model: asked.model, conf: asked.conf, effort: effortFor(asked.model, input.text, input.subagentType) }
        by = 'jev'
        await update($, jev, u => ({ calls: (u?.calls ?? 0) + 1, input: asked.input, output: asked.output }))
      }
    }
    // Creative work is set to its case's tier whoever chose (pickRoute already did it for the rules)
    pick = creativeFloor(pick, input)
    // Cost guards run last, on whoever picked: they cap what the turn may spend
    const u = await read($, usage)
    const turnCost = u?.cost != null ? Math.max(0, u.cost - turnCostStart) : null
    const guarded = guard({
      pick,
      pin: e.agentId ? null : (turnPin ?? (opts.pin ? { model: opts.pin, effort: opts.pinEffort } : null)),
      maxEffort: opts.maxEffort,
      budget: opts.budget,
      ctxCap: opts.ctxCap,
      isSub: Boolean(e.agentId),
      isPlan: input.subagentType === 'Plan',
      step: e.index,
      textLen: input.text.length,
      turnTools,
      contextTokens: u?.context.tokens ?? null,
      turnCost,
      creative: opts.creative === 'off' || input.subagentType === 'Explore' ? null : creativeOf(input.text),
      creativeCap: opts.creativeCap,
    })
    if (!warned && guarded.limits.some(l => l.startsWith('turn $') || l.startsWith('ctx '))) {
      warned = true
      $.ui.toast(`ClaudeRouter: ${guarded.limits.join(', ')}. Downgraded to ${guarded.model}/${guarded.effort}.`)
    }
    pick = { ...pick, model: guarded.model, effort: guarded.effort }
    const kept = familyOf(e.model) === pick.model
    const sentId = idFor(pick.model, e.model)
    if (!e.agentId) routedLocked = opts.locks.includes(pick.model) ? sentId : null
    const result = yield* next({ ...e, model: sentId, effort: pick.effort })

    const decided: Route = {
      model: pick.model,
      effort: pick.effort,
      conf: pick.conf,
      kept,
      by,
      engineModel: e.model,
      source: e.agentId ? 'subagent' : 'main',
      // The band's second line only appears when something needs explaining: a Jev pick or a guard limit.
      // The prompt excerpt, keyword, length and tool list (whyOf) are no longer echoed.
      why: [by === 'jev' ? 'jev' : '', guarded.limits.length > 0 ? `guard ${guarded.limits.join(',')}` : ''].filter(Boolean).join(' · '),
    }
    await update($, route, () => decided)
    if (e.agentId) {
      const agentId = e.agentId
      await update($, tasks, list => patchAgent(list, agentId, { model: pick.model, effort: pick.effort }))
    } else {
      const turn = e.turnId
      await update($, tasks, list => patchTask(list, turn, { steps: e.index + 1, model: pick.model, effort: pick.effort }))
    }
    return result
  })

  // Runs before each tool call: counts the turn's tools, and MCP calls by server and tool
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) turnTools = [...turnTools.slice(-49), e.tool]
    if (e.tool.startsWith('mcp__')) {
      const [, server = '', ...rest] = e.tool.split('__')
      const tool = rest.join('__')
      await update($, mcp, list => bumpMcp(list, server, tool))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when a skill's text is expanded for Claude: it has loaded and is in use
  on('skill.prompt', async ($, e, next) => {
    await update($, skills, list => bumpSkill(list, e.skill))
    return next(e)
  })

  // Runs as each hooks module loads: the plugin names ClaudeRouter can see
  on('plugin.register', async ($, e, next) => {
    await update($, plugins, list => addPlugin(list, e.name))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when a subagent is about to start. A model the Agent call already named stays as it is.
  on('agent.spawn', async ($, e, next) => {
    const text = `${e.description} ${e.prompt}`
    const opts = normalize(await read($, options))
    const pick = pickRoute({ text, tools: [], subagentType: e.subagentType, creative: opts.creative })
    // Subagents never start on Opus (or Fable) unless they plan: execution is Sonnet or Haiku
    const spawnModel = (pick.model === 'opus' || pick.model === 'fable') && e.subagentType !== 'Plan' ? 'sonnet' : pick.model
    // A locked session stays locked, subagents included: one that names no model inherits the parent's model
    // (until /clauderouter unlock). A parent id the router does not know is inherited too: it is never rewritten.
    const parentFamily = familyOf(e.parentModel)
    const parentLocked = parentFamily === null || opts.locks.includes(parentFamily)
    const inherit = !e.model && parentLocked
    const result = await next({ ...e, model: e.model ?? (inherit ? e.parentModel : spawnModel) })
    if (result.deny) return result

    if (result.agentId) subagents.set(result.agentId, { text, subagentType: e.subagentType, explicit: Boolean(e.model) || inherit })
    const agent: Agent = {
      id: result.agentId ?? null,
      name: e.description || e.subagentType,
      role: roleOf(e.subagentType, text),
      model: result.model ?? null,
      effort: null,
      status: 'running',
      startedAt: await $.clock.now(),
      seconds: null,
      tokens: 0,
    }
    await update($, tasks, list => attachAgent(list, turnId, agent))
    return result
  }).catch(($, e, next) => next(e))

  // Runs when a turn ends, for the main conversation and for each subagent
  on('turn.complete', async ($, e, next) => {
    const tokens = e.usage ? e.usage.input_tokens + e.usage.output_tokens : 0
    const status = e.reason === 'error' ? 'failed' : 'done'
    const seconds = e.durationMs / 1000
    const agentId = e.agentId
    await update($, totals, t => ({ tokens: t.tokens + tokens, turns: t.turns + (agentId ? 0 : 1) }))

    if (agentId) {
      await update($, tasks, list => patchAgent(list, agentId, { status, seconds, tokens }))
    } else {
      busy = false
      await update($, tasks, list => patchTask(list, e.turnId, { status, seconds, tokens }))
      const raw = await $.session.usage()
      await update($, usage, () => toUsage(raw))
    }
    return next(e)
  })

  // Runs when the session's figures change: context, rate limits, cost
  on('session.measure', async ($, e, next) => {
    await update($, usage, prev => toUsage({ ...e, startedAt: prev?.startedAt ?? 0 }))
    return next(e)
  })

  // Draws the ClaudeRouter band above the prompt, one row per fact the events expose
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await snapshot($, e.surface, e.props.bodyColumns, e.props.maxRows)
    terminal = snap.terminal
    const { band } = normalize(await read($, options))
    // Closed: nothing above the prompt until `/clauderouter band full` (or `route`)
    if (band === 'off') return next(e)
    const els = $.ui.resolve(e) as Els
    const tree = band === 'route' ? drawStrip(els, snap) : drawBand(els, snap)
    mounted.set(e.requestId, snap.anim)
    // The close control: the desktop draws its native close mark at the band's trailing edge, the terminal a plain ✕
    const close = els.Button({
      key: 'clauderouter-close',
      label: snap.terminal ? '✕' : 'Close ClaudeRouter',
      plain: true,
      dimColor: true,
      role: 'dismiss',
      onPress: () => {
        void update($, options, o => ({ ...normalize(o), band: 'off' as const }))
        void $.ui.toast('ClaudeRouter band closed. /clauderouter band full brings it back.')
      },
    })
    return els.Box({ flexDirection: 'row', columnGap: 2, children: [tree, close] })
  })

  // Draws the /ClaudeRouter pane: the cards, the running and finished lists
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const snap = await snapshot($, e.surface, e.props.bodyColumns, e.props.scroll.bodyRows)
    terminal = snap.terminal
    const tree = drawPane($.ui.resolve(e) as Els, snap)
    mounted.set(e.requestId, snap.anim)
    return tree
  })
}
