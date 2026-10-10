import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Agent, Route, Task } from '../types'
import { JEV_TIMEOUT_MS, askJev } from './jev'
import { DEFAULT_OPTIONS, WARM_EVERY_MS, applyArgs } from './options'
import { type Els, type Snapshot, drawBand } from './band'
import { drawPane } from './pane'
import { type Anim, animCells } from './pixel'
import { effortFor, familyOf, idFor, pickRoute, roleOf, whyOf } from './route'
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
// When the main thread last sent a request, for keep-warm
let lastRequestAt: number | null = null
const subagents = new Map<string, { text: string; subagentType?: string }>()
// The Rasters each drawn site mounted that shimmer or move: what the timer repaints with $.ui.blit
const mounted = new Map<string, Anim[]>()

// Gathers what a drawing reads. The validator follows $ only into functions declared at the top of the file.
async function snapshot($: EngineInterface, surface: string, columns: number, rows: number): Promise<Snapshot> {
  return {
    route: await read($, route),
    tasks: await read($, tasks),
    skills: await read($, skills),
    mcp: await read($, mcp),
    plugins: await read($, plugins),
    usage: await read($, usage),
    jev: await read($, jev),
    totals: await read($, totals),
    now: await $.clock.now(),
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
          if (a.kind === 'sprite' && frame % 4 !== 0) continue
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
      const { next, text } = applyArgs(e.args, await read($, options), now)
      if (next) await update($, options, () => next)
      return { text }
    }
    await $.ui.open({ id: PANE, title: 'ClaudeRouter', closeOnEscape: true })
    return {}
  })

  // Runs when a turn begins: a new task row, named by the prompt
  on('turn.start', async ($, e, next) => {
    busy = true
    turnId = e.turnId
    turnText = e.text
    turnTools = []
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
    const input = {
      text: e.agentId ? (sub?.text ?? '') : turnText,
      tools: e.agentId ? [] : turnTools,
      subagentType: sub?.subagentType,
      current: familyOf(e.model),
    }
    let pick = pickRoute(input)
    let by: Route['by'] = 'rules'
    if (!e.agentId) lastRequestAt = await $.clock.now()
    if ((await read($, options)).engine === 'jev') {
      const key = await $.env.get('TYPESAFE_API_KEY')
      const timeout = new Promise<null>(resolve => { $.clock.after(JEV_TIMEOUT_MS, () => resolve(null)) })
      const asked = key ? await Promise.race([askJev((url, init) => $.http.fetch(url, init), key, input), timeout]) : null
      if (asked) {
        pick = { model: asked.model, conf: asked.conf, effort: effortFor(asked.model, input.text, input.subagentType) }
        by = 'jev'
        await update($, jev, u => ({ calls: (u?.calls ?? 0) + 1, input: asked.input, output: asked.output }))
      }
    }
    const kept = familyOf(e.model) === pick.model
    const result = yield* next({ ...e, model: idFor(pick.model, e.model), effort: pick.effort })

    const decided: Route = {
      model: pick.model,
      effort: pick.effort,
      conf: pick.conf,
      kept,
      by,
      engineModel: e.model,
      source: e.agentId ? 'subagent' : 'main',
      why: (by === 'jev' ? 'jev · ' : '') + whyOf(input),
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
    const pick = pickRoute({ text, tools: [], subagentType: e.subagentType })
    const result = await next({ ...e, model: e.model ?? pick.model })
    if (result.deny) return result

    if (result.agentId) subagents.set(result.agentId, { text, subagentType: e.subagentType })
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
    const tree = drawBand($.ui.resolve(e) as Els, snap)
    mounted.set(e.requestId, snap.anim)
    return tree
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
