import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Agent, Effort, Model, Route, Task, Who } from '../types'
import { JEV_TIMEOUT_MS, type JevPick, askJev } from './jev'
import { DEFAULT_OPTIONS, OPTION_ALIASES, OPTION_COMMANDS, WARM_EVERY_MS, applyArgs, normalize, sizeText } from './options'
import { type Pin, directiveOf, guard, managerVerdict, toLevel } from './guard'
import { type End, type Line, type LogPaths, REVIEW_AGENT, blockLine, dateOf, endLine, followLine, fromJsonl, launchLine, logPaths, mainLine, mcpLine, mdOf, projectName, reviewPrompt, sessionLine, skillLine, skillsNamed, stamp, taskLine, toJsonl, verdictLine, verdictOf } from './sessionlog'
import { type EnvFacts, type Front, type Io, agentDirs, costOf, deckText, effortForHeld, envFacts, envWarnings, findFront, isBuiltin, isRouted, mergePrices, parsePrices, pricesEmpty, whoSets } from './orchestrate'
import { type Els, type Snapshot, drawBand, drawStrip } from './band'
import { drawPane } from './pane'
import { type Anim, animCells } from './pixel'
import { carriesOn, creativeFloor, creativeOf, effortFor, familyOf, idFor, isPlanner, pickRoute, roleOf } from './route'
import { attachAgent, addPlugin, bumpMcp, bumpSkill, nameOf, patchAgent, patchTask, toUsage } from './lists'

const COMMANDS: [string, string][] = [...OPTION_COMMANDS.map(c => [c, c] as [string, string]), ...Object.entries(OPTION_ALIASES)]

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
const warnings = atom({ plugin: 'agent-ClaudeRouter', key: 'warnings' } as const, [])
const prices = atom({ plugin: 'agent-ClaudeRouter', key: 'prices' } as const, {})
const logfile = atom({ plugin: 'agent-ClaudeRouter', key: 'logfile' } as const, null)

// Shared by the hooks below. A reload starts them over; $.state keeps what the band shows.
let busy = false
let frame = 0
let terminal = false
let turnId = ''
let turnText = ''
let turnTools: string[] = []
// Cost guards: the session cost when this turn began, and a "@model:effort" prompt prefix
let turnCostStart = 0
let turnPin: Pin | null = null
// The locked model id the router itself last sent on the main thread (Fable for flagship creative work, when
// /cr-creative fable is on). A request arriving on that id is the router's own choice, not the user's,
// so the lock does not freeze it there.
let routedLocked: string | null = null
// When the main thread last sent a request, for keep-warm
let lastRequestAt: number | null = null
// The route the main thread last ran on, and the one the previous turn ended on. A short prompt with no signal of
// its own ("yes go ahead") carries on with the latter. Null after a locked (passed-through) request.
let lastMain: { model: Model; effort: Effort } | null = null
let prevRoute: { model: Model; effort: Effort } | null = null
// Jev's answer for this turn, per thread ('main' or a subagent id). The prompt does not change between the requests
// of a turn, so Jev is asked once, not before every request. null = it failed: the rules decide for the rest of the turn.
const jevMemo = new Map<string, JevPick | null>()
// who: which of its model and effort someone other than the router set (agent file, Agent call, environment, default).
// The router routes only the part nobody set; the rest is passed through untouched on every request.
const subagents = new Map<string, { text: string; subagentType?: string; who: Who }>()
// The Agent call's own effort, by tool call id: agent.spawn does not carry it, the tool.call before it does
const callEfforts = new Map<string, string>()
// A main-thread turn woken by a sub-agent's hand-back continues the task it belongs to: its turn id points at that task
const aliases = new Map<string, string>()
const taskOf = (id: string) => aliases.get(id) ?? id
// The text a hand-back turn starts with: the engine's agent-message envelope, not something you typed
const HAND_BACK = /^\s*<[^>]*agent-message/i
// The session log (see sessionlog.ts): its lines so far, where they go, the number of the current task, and what is known
// of each running agent. A reload re-reads the file named by the logfile atom.
let logLines: Line[] = []
let logPath: LogPaths | null = null
let taskNo = 0
const agentMeta = new Map<string, { n: number; type: string; model: string; named: string[]; maxTurns: number | null; steps: number; handback?: ReturnType<typeof verdictOf> }>()
// The review agent's job: where its answer is written when it ends
const reviewJobs = new Map<string, string>()
// Where agent files live: the session's folder and the user's home, and every plugin's root by name
let sessionCwd = ''
let home: string | undefined
const pluginRoots = new Map<string, string>()
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE and CLAUDE_CODE_EFFORT_LEVEL, read at session start
let env: EnvFacts = envFacts({})
// The Rasters each drawn site mounted that shimmer or move: what the timer repaints with $.ui.blit
const mounted = new Map<string, Anim[]>()

// The frontmatter of the agent type a spawn names, read from the agent files the engine reads itself: the project's
// .claude/agents (and its parents'), the user's, and a plugin's agents folder for "plugin:name". Null when none is found.
async function frontOf($: EngineInterface, type: string): Promise<Front | null> {
  if (!type) return null
  const io: Io = {
    read: path => $.fs.read(path).then(text => (typeof text === 'string' ? text : null), () => null),
    list: path => $.fs.list(path).then(list => list, () => []),
  }
  const colon = type.indexOf(':')
  const root = colon >= 0 ? pluginRoots.get(type.slice(0, colon)) : undefined
  const dirs = colon >= 0 ? (root ? [`${root.replace(/\\/g, '/')}/agents`] : []) : agentDirs(sessionCwd, home)
  return findFront(type, dirs, io).catch(() => null)
}

// Appends one line to the session log, from named fields only (see the constructors in sessionlog.ts), and rewrites the file
async function emit($: EngineInterface, line: Line): Promise<void> {
  if (!logPath) return
  logLines.push(line)
  await $.fs.write(logPath.jsonl, toJsonl(logLines)).catch(() => undefined)
}
const mode$ = async ($: EngineInterface) => normalize(await read($, options)).orchestrator
const costNow = async ($: EngineInterface, model: string, use: { tokensIn?: number; tokensWrite?: number; tokensCached?: number; tokensOut?: number }) => costOf(model, use, await read($, prices))

// The orchestrator rules: ~/.claude/orchestrator.md, injected into the main session when the mode is on. Null when missing.
const rulesPath = () => `${(home ?? '~').replace(/\\/g, '/')}/.claude/orchestrator.md`
async function loadRules($: EngineInterface): Promise<string | null> {
  return $.fs.read(rulesPath()).then(t => (typeof t === 'string' && t.trim() !== '' ? t : null), () => null)
}
const byteLength = (text: string) => new TextEncoder().encode(text).length

// Puts the rules into the main conversation as a note. Never into a sub-agent: its loop has its own conversation.
// Resolves to why it failed, or null.
async function injectRules($: EngineInterface, rules: string): Promise<string | null> {
  const text = `<orchestrator-rules source="~/.claude/orchestrator.md">\nClaudeRouter orchestrator mode is on. You manage; you do not do the work. These rules apply to this session until the mode is turned off:\n\n${rules}\n</orchestrator-rules>`
  try {
    const done = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return 'deny' in done && done.deny ? String(done.deny) : null
  } catch (error) {
    return error instanceof Error ? error.message : 'append failed'
  }
}

// The price table: the file shipped with the plugin (empty), overridden field by field by ~/.claude/clauderouter-prices.json.
// A file that is missing or does not parse is an empty table: no price is ever guessed.
async function loadPrices($: EngineInterface): Promise<void> {
  const shipped = await $.fs.read(`${$.plugin.root.replace(/\\/g, '/')}/prices.json`).then(t => (typeof t === 'string' ? t : null), () => null)
  const mine = home ? await $.fs.read(`${home.replace(/\\/g, '/')}/.claude/clauderouter-prices.json`).then(t => (typeof t === 'string' ? t : null), () => null) : null
  const table = mergePrices(parsePrices(shipped), parsePrices(mine))
  await update($, prices, () => table)
}

// The session logs of a project folder, oldest first (their names start with the date and time)
async function sessionFiles($: EngineInterface, dir: string): Promise<string[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(f => f.kind === 'file' && f.name.endsWith('.jsonl')).map(f => f.name).sort()
}

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
    warnings: await read($, warnings),
    prices: await read($, prices),
    orchestrator: normalize(await read($, options)).orchestrator,
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
    await $.command.register({ name: 'cr', description: 'Open ClaudeRouter: cost, tokens, time, running and finished agents', immediate: true })
    await $.command.register({ name: 'cr-log', description: 'ClaudeRouter: this session\'s log as a table (/cr-log last: the previous session\'s)', immediate: true })
    await $.command.register({ name: 'cr-review', description: 'ClaudeRouter: review the last n session logs of this project (default 10) with one Sonnet agent', immediate: true })
    await $.command.register({ name: 'cr-prices', description: 'ClaudeRouter: reload the price table and say which prices are filled in', immediate: true })
    await $.command.register({ name: 'cr-deck', description: 'ClaudeRouter: the agent deck as text: each agent, its model and effort, who set them, tokens in and out', immediate: true })
    for (const [name, sub] of COMMANDS) {
      await $.command.register({ name: `cr-${name}`, description: `ClaudeRouter: ${sub === name ? sub : `${sub} (short: ${name})`} (/cr-${name} with no argument shows its usage)`, immediate: true })
    }
    // The dashboard opens as a pane, taller than the default and draggable by the person; the band above the prompt keeps the route only
    void $.ui.open({ id: PANE, title: 'ClaudeRouter', rows: 24, closeOnEscape: true }).catch(() => undefined)
    const raw = await $.session.usage()
    await update($, usage, () => toUsage(raw))
    // Where agent files live, and the two variables that override every model and effort choice
    sessionCwd = e.cwd
    pluginRoots.set($.plugin.name, $.plugin.root)
    // A variable that cannot be read counts as unset: the rest of session.start must still run
    home = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))
    env = envFacts({
      force: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE').catch(() => undefined),
      model: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL').catch(() => undefined),
      effort: await $.env.get('CLAUDE_CODE_EFFORT_LEVEL').catch(() => undefined),
    })
    await loadPrices($)
    // A reload with the mode already on and the rules not loaded (a first load, or a failed one): load them now
    const mine = normalize(await read($, options))
    if (mine.orchestrator !== 'off' && mine.rules === null) {
      const rules = await loadRules($)
      if (rules !== null && (await injectRules($, rules)) === null) await update($, options, o => ({ ...normalize(o), rules: byteLength(rules) }))
    }
    // The session log: a new file, or the one a reload was already writing
    if (home) {
      const prior = await read($, logfile)
      if (prior) {
        logPath = { jsonl: prior, md: prior.replace(/\.jsonl$/, '.md'), dir: prior.slice(0, prior.lastIndexOf('/')) }
        logLines = fromJsonl(await $.fs.read(prior).then(t => (typeof t === 'string' ? t : ''), () => ''))
        taskNo = logLines.filter(l => l.t === 'task').length
      } else {
        const at = await $.clock.now()
        logPath = logPaths(home, e.cwd, at, await $.session.id().catch(() => 'session'))
        logLines = []
        taskNo = 0
        const file = logPath.jsonl
        await update($, logfile, () => file)
        await emit($, sessionLine(at, 'start', projectName(e.cwd), await mode$($)))
      }
    }
    // The agent /cr-review runs: Sonnet at medium, Read and Grep only (the prompt names the files)
    await $.agent.register({
      name: REVIEW_AGENT,
      description: 'Reads ClaudeRouter session logs (JSON lines) and reports per-agent cost, follow-ups, skills, guard blocks and at most five proposed edits. Used by /cr-review only.',
      prompt: 'You review ClaudeRouter session logs. You read only the files the brief names, with Read and Grep, count lines for every claim, and answer with the review as Markdown. You change and write nothing.',
      tools: ['Read', 'Grep'],
      model: 'sonnet',
      effort: 'medium',
      maxTurns: 20,
      omitClaudeMd: true,
    }).catch(() => undefined)
    const warned = envWarnings(env)
    await update($, warnings, () => warned)
    for (const line of warned) $.ui.toast(`ClaudeRouter: ${line}`)
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

  // Runs when you type /cr-<option>: /cr-warm 2h is the option 'warm' with the argument '2h'
  for (const [name, sub] of COMMANDS) {
    on('command.run', { command: `cr-${name}` }, async ($, e) => {
      const now = await $.clock.now()
      const current = normalize(await read($, options))
      const { next, text } = applyArgs(`${sub} ${e.args}`, current, now)
      // Turning the orchestrator on needs its rules: a missing file is said, not confirmed
      if (sub === 'orchestrator' && next && next.orchestrator !== 'off') {
        const rules = await loadRules($)
        if (rules === null) return { text: `orchestrator not turned on: the rules file is missing or empty: ${rulesPath()}. Create it, then run the command again.` }
        const size = byteLength(rules)
        // Already loaded in this conversation (on to hands on, or the reverse): do not load them twice
        const failed = current.orchestrator !== 'off' && current.rules !== null ? null : await injectRules($, rules)
        await update($, options, () => ({ ...next, rules: failed === null ? size : null }))
        if (failed !== null) return { text: `orchestrator: ${next.orchestrator === 'on' ? 'on · manager only' : 'hands on · guard off'} · rules NOT loaded (${failed})` }
        return { text: next.orchestrator === 'on' ? `orchestrator: on · manager only · rules loaded (${sizeText(size)})` : `orchestrator: hands on · guard off · rules loaded (${sizeText(size)})` }
      }
      if (next) await update($, options, () => next)
      return { text }
    }).catch(($, e, next) => next(e))
  }

  // Runs when you type /cr-deck: the same deck the pane draws, as text with exact figures
  on('command.run', { command: 'cr-deck' }, async ($, e) => {
    await loadPrices($)
    const list = await read($, tasks)
    return { text: deckText(e.args.trim() === 'last' ? list.slice(-1) : list, await read($, prices)) }
  })

  // Runs when you type /cr-log: the session log as a table. "last" reads the previous session's file instead.
  on('command.run', { command: 'cr-log' }, async ($, e) => {
    if (!logPath) return { text: 'session log: off (no home folder found)' }
    const now = await $.clock.now()
    if (e.args.trim() !== 'last') return { text: `${mdOf(logLines, now)}\n${logPath.jsonl}` }
    const files = await sessionFiles($, logPath.dir)
    const previous = files.filter(f => f !== logPath?.jsonl.split('/').pop()).at(-1)
    if (!previous) return { text: 'no earlier session log for this project' }
    const text = await $.fs.read(`${logPath.dir}/${previous}`).then(t => (typeof t === 'string' ? t : ''), () => '')
    return { text: `${mdOf(fromJsonl(text))}\n${logPath.dir}/${previous}` }
  })

  // Runs when you type /cr-review [n]: one Sonnet agent at medium effort reads the last n logs of this project and reports.
  // The hook writes its answer to reviews/<date>.md; nothing is edited.
  on('command.run', { command: 'cr-review' }, async ($, e) => {
    if (!logPath) return { text: 'session log: off (no home folder found)' }
    const asked = Number.parseInt(e.args.trim(), 10)
    const count = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 50) : 10
    const files = (await sessionFiles($, logPath.dir)).slice(-count).map(f => `${logPath?.dir}/${f}`)
    if (files.length === 0) return { text: 'no session logs for this project yet' }
    const at = await $.clock.now()
    const taken = await $.fs.exists(`${logPath.dir}/reviews/${dateOf(at)}.md`).catch(() => false)
    const out = `${logPath.dir}/reviews/${taken ? stamp(at) : dateOf(at)}.md`
    const started = await $.agent.spawn({ prompt: reviewPrompt(files, logPath.dir.split('/').pop() ?? ''), description: 'Review session logs', subagentType: `${$.plugin.name}:${REVIEW_AGENT}`, model: 'sonnet' })
    if (started.deny || !started.agentId) return { text: `review not started: ${started.deny ?? 'no agent id'}` }
    reviewJobs.set(started.agentId, out)
    return { text: `review started on ${files.length} log${files.length === 1 ? '' : 's'}: sonnet, medium, Read and Grep only. It will be written to ${out}; it changes nothing.` }
  })

  // Runs when the session ends: the closing line, and the readable summary next to the log
  on('session.end', async ($, e, next) => {
    if (logPath) {
      const at = await $.clock.now()
      await emit($, sessionLine(at, 'end', logPath.dir.split('/').pop() ?? '', await mode$($)))
      await $.fs.write(logPath.md, mdOf(logLines, at)).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when you type /cr-prices: reloads the table and says what is filled in
  on('command.run', { command: 'cr-prices' }, async ($) => {
    await loadPrices($)
    const table = await read($, prices)
    if (pricesEmpty(table)) return { text: 'prices missing: fill in prices.json in the plugin folder, or ~/.claude/clauderouter-prices.json (USD per million tokens), then /cr-prices' }
    return { text: Object.entries(table).map(([m, p]) => `${m}: input ${p?.input ?? '—'} · output ${p?.output ?? '—'} · cache write ${p?.cacheWrite ?? '—'} · cache read ${p?.cacheRead ?? '—'}`).join('\n') }
  })

  // Runs when you type /cr. Opening the pane draws nothing by itself; ui.render fills it.
  on('command.run', { command: 'cr' }, async ($, e) => {
    // A bare /cr also brings back a band that was closed with the ✕, so it can never be lost
    const o = normalize(await read($, options))
    const restored = o.band === 'off'
    if (restored) await update($, options, () => ({ ...o, band: 'full' as const }))
    await $.ui.open({ id: PANE, title: 'ClaudeRouter', rows: 24, closeOnEscape: true })
    return restored ? { text: 'ClaudeRouter band restored: /cr-band off closes it' } : {}
  })

  // Runs when a turn begins: a new task row, named by the prompt
  on('turn.start', async ($, e, next) => {
    // A sub-agent's own run is not a task: its row is the agent under the task that spawned it
    if (e.agentId) return next(e)
    busy = true
    // A hand-back wakes the main loop to read a sub-agent's report: it continues the last task, it is not a new one
    const last = (await read($, tasks)).at(-1)
    if (last && HAND_BACK.test(e.text)) {
      aliases.set(e.turnId, last.id)
      turnId = last.id
      await update($, tasks, list => patchTask(list, last.id, { status: 'running' }))
      return next(e)
    }
    turnId = e.turnId
    turnText = e.text
    taskNo += 1
    await emit($, taskLine(await $.clock.now(), taskNo, e.text, await mode$($)))
    turnTools = []
    turnPin = directiveOf(e.text)
    prevRoute = lastMain
    jevMemo.clear()
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
    const meta = e.agentId ? agentMeta.get(e.agentId) : undefined
    if (meta) meta.steps += 1
    // Options saved by an older version lack the guard fields, or carry the old fableLock flag: normalize fills them in
    const opts = normalize(await read($, options))
    const input = {
      text: e.agentId ? (sub?.text ?? '') : turnText,
      tools: e.agentId ? [] : turnTools,
      subagentType: sub?.subagentType,
      current: familyOf(e.model),
      creative: opts.creative,
      prev: e.agentId ? null : prevRoute,
    }
    let pick = pickRoute(input)
    let by: Route['by'] = 'rules'
    if (!e.agentId) lastRequestAt = await $.clock.now()
    // Pass-through: the request keeps the model and effort it arrived with, and the band says why.
    //  - orchestrator mode, or a model lock (Fable by default), or an id the router does not know: a main-thread
    //    session is left alone, unless a pin or an "@model" prefix says otherwise.
    //  - a subagent keeps each part someone else set: its model when the Agent call, its file or an environment
    //    variable set it, its effort likewise. The router only fills in the part nobody set. A subagent on a locked
    //    model keeps both.
    const family = familyOf(e.model)
    const locked = family !== null && opts.locks.includes(family)
    const orchestrating = opts.orchestrator !== 'off'
    const lockMain = !e.agentId && (orchestrating || family === null || locked) && !turnPin && !opts.pin && e.model !== routedLocked
    const heldModel = Boolean(e.agentId) && (locked || (sub !== undefined && !isRouted(sub.who.model)))
    const heldEffort = Boolean(e.agentId) && (locked || (sub !== undefined && !isRouted(sub.who.effort)))
    if (lockMain || (heldModel && heldEffort)) {
      const level = toLevel(e.effort)
      const shown: Model = family ?? 'fable'
      const passed = yield* next(e)
      const why = e.agentId
        ? (sub ? `model ${sub.who.model} · effort ${sub.who.effort} · left as they are` : `${family} lock · agent left as it is`)
        : orchestrating && !(family === null || locked) ? 'orchestrator · your model choice is left as it is' : `${family ?? 'unknown model'} lock · your model choice is left as it is`
      const kept: Route = { model: shown, effort: level ?? 'high', conf: 1, kept: true, by: 'rules', engineModel: e.model, source: e.agentId ? 'subagent' : 'main', why }
      await update($, route, () => kept)
      if (e.agentId) {
        const agentId = e.agentId
        await update($, tasks, list => patchAgent(list, agentId, { model: shown, effort: level }))
      } else {
        const lockedTurn = taskOf(e.turnId)
        lastMain = null
        await update($, tasks, list => patchTask(list, lockedTurn, { steps: e.index + 1, model: shown, effort: level ?? 'high' }))
      }
      return passed
    }
    // A subagent whose model is set but whose effort is not: the router's ladder for that model, never the guard's
    // model changes. A subagent whose effort is set but whose model is not goes through the usual pick, then keeps its effort.
    let limits: string[] = []
    if (heldModel) {
      const heldFamily = family ?? 'sonnet'
      pick = { model: heldFamily, effort: effortForHeld(heldFamily, input.text, input.subagentType, opts.maxEffort), conf: 1 }
    } else {
      // A prompt that only carries on ("yes go ahead") keeps the previous route: Jev is not asked about it
      if (opts.engine === 'jev' && !carriesOn(input)) {
        const memoKey = e.agentId ?? 'main'
        let asked = jevMemo.get(memoKey) ?? null
        if (!jevMemo.has(memoKey)) {
          const key = await $.env.get('TYPESAFE_API_KEY')
          const timeout = new Promise<null>(resolve => { $.clock.after(JEV_TIMEOUT_MS, () => resolve(null)) })
          asked = key ? await Promise.race([askJev((url, init) => $.http.fetch(url, init), key, input), timeout]) : null
          jevMemo.set(memoKey, asked)
          const called = asked
          if (called) await update($, jev, u => ({ calls: (u?.calls ?? 0) + 1, input: called.input, output: called.output }))
        }
        if (asked) {
          pick = { model: asked.model, conf: asked.conf, effort: effortFor(asked.model, input.text, input.subagentType) }
          by = 'jev'
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
        isPlan: isPlanner(input.subagentType),
        step: e.index,
        textLen: input.text.length,
        turnTools,
        contextTokens: u?.context.tokens ?? null,
        turnCost,
        creative: opts.creative === 'off' || input.subagentType === 'Explore' ? null : creativeOf(input.text),
        creativeCap: opts.creativeCap,
      })
      pick = { ...pick, model: guarded.model, effort: guarded.effort }
      limits = guarded.limits
    }
    if (heldEffort) {
      const level = toLevel(e.effort)
      if (level) pick = { ...pick, effort: level }
    }
    const kept = familyOf(e.model) === pick.model
    const sentId = heldModel ? e.model : idFor(pick.model, e.model)
    if (!e.agentId) {
      routedLocked = opts.locks.includes(pick.model) ? sentId : null
      lastMain = { model: pick.model, effort: pick.effort }
    }
    // A held effort goes out exactly as it arrived, a number or a level this router does not pick
    const sentEffort = heldEffort ? e.effort : pick.effort
    const result = yield* next({ ...e, model: sentId, ...(sentEffort === undefined ? {} : { effort: sentEffort }) })

    const decided: Route = {
      model: pick.model,
      effort: pick.effort,
      conf: pick.conf,
      kept,
      by,
      engineModel: e.model,
      source: e.agentId ? 'subagent' : 'main',
      // The band's second line only appears when something needs explaining: a Jev pick, a guard limit, a held part.
      // The prompt excerpt, keyword, length and tool list (whyOf) are no longer echoed.
      why: [
        by === 'jev' ? 'jev' : '',
        heldModel ? `model ${sub?.who.model ?? 'held'}` : '',
        heldEffort ? `effort ${sub?.who.effort ?? 'held'}` : '',
        limits.length > 0 ? `guard ${limits.join(',')}` : '',
      ].filter(Boolean).join(' · '),
    }
    await update($, route, () => decided)
    if (e.agentId) {
      const agentId = e.agentId
      const shownEffort = heldEffort ? toLevel(e.effort) : pick.effort
      await update($, tasks, list => patchAgent(list, agentId, { model: pick.model, effort: shownEffort }))
    } else {
      const turn = taskOf(e.turnId)
      await update($, tasks, list => patchTask(list, turn, { steps: e.index + 1, model: pick.model, effort: pick.effort }))
    }
    return result
  })

  // Runs before each tool call: counts the turn's tools, and MCP calls by server and tool
  on('tool.call', async ($, e, next) => {
    // Manager guard: with the orchestrator on, the main thread (never a sub-agent) may not read code, edit files or run
    // commands. The refusal names the agent to use. A guard that fails lets the call through (see .catch below).
    if (!e.agentId && normalize(await read($, options)).orchestrator === 'on') {
      const denied = managerVerdict(e.tool, e as unknown as Record<string, unknown>, { home })
      if (denied !== null) {
        const task = turnId
        await update($, tasks, list => list.map(t => (t.id === task ? { ...t, blocks: (t.blocks ?? 0) + 1 } : t)))
        await emit($, blockLine(await $.clock.now(), taskNo, denied))
        return { deny: denied.message }
      }
    }
    // The log: skills and MCP tools per agent (names only), and the main thread sending an agent back
    const raw = e as unknown as Record<string, unknown>
    const who = e.agentId ? agentMeta.get(e.agentId) : undefined
    if (e.tool === 'Skill' && typeof raw.skill === 'string') {
      await emit($, skillLine(await $.clock.now(), who?.n ?? taskNo, { agent: who?.type ?? 'main', id: e.agentId ?? 'main', skill: raw.skill, named: who?.named.includes(raw.skill) ?? false }))
    }
    if (e.tool.startsWith('mcp__')) {
      const [, server = '', ...rest] = e.tool.split('__')
      await emit($, mcpLine(await $.clock.now(), who?.n ?? taskNo, { agent: who?.type ?? 'main', id: e.agentId ?? 'main', server, tool: rest.join('__') }))
    }
    // A sub-agent delivers its report through SubagentHandback: count its verdict words now and keep only the counts
    if ((e.tool as string) === 'SubagentHandback' && e.agentId && typeof raw.message === 'string') {
      const meta = agentMeta.get(e.agentId)
      if (meta) meta.handback = verdictOf(raw.message)
    }
    if (e.tool === 'SendMessage' && !e.agentId && typeof raw.to === 'string') {
      const target = raw.to
      const known = [...agentMeta.entries()].find(([id]) => id === target)?.[1]
      await emit($, followLine(await $.clock.now(), taskNo, known?.type ?? target))
    }
    if (!e.agentId) turnTools = [...turnTools.slice(-49), e.tool]
    // An Agent call's own effort rides with the spawn that follows it, which does not carry it
    if (e.tool === 'Agent' && typeof e.effort === 'string') {
      if (callEfforts.size > 50) callEfforts.clear()
      callEfforts.set(e.tool_use_id, e.effort)
    }
    if (e.tool.startsWith('mcp__')) {
      const [, server = '', ...rest] = e.tool.split('__')
      const tool = rest.join('__')
      await update($, mcp, list => bumpMcp(list, server, tool))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when the conversation is compacted: the summary replaces the rules note, so the main session gets it again
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && normalize(await read($, options)).orchestrator !== 'off') {
      const rules = await loadRules($)
      if (rules !== null) await injectRules($, rules)
    }
    return done
  }).catch(($, e, next) => next(e))

  // Runs when a skill's text is expanded for Claude: it has loaded and is in use
  on('skill.prompt', async ($, e, next) => {
    await update($, skills, list => bumpSkill(list, e.skill))
    return next(e)
  })

  // Runs as each hooks module loads: the plugin names ClaudeRouter can see
  on('plugin.register', async ($, e, next) => {
    await update($, plugins, list => addPlugin(list, e.name))
    pluginRoots.set(e.name, e.root)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when a subagent is about to start. A model or effort that the Agent call or the agent's file set stays as it
  // is; the router fills in only the part nobody set.
  on('agent.spawn', async ($, e, next) => {
    // A resumed agent (a follow-up message wakes a finished one) is the same row, not a second agent
    if (e.resume) {
      const again = e.resume.agentId
      const resumed = await next(e)
      if (!resumed.deny) {
        await update($, tasks, list => patchAgent(list, again, { status: 'running' }))
        await emit($, followLine(await $.clock.now(), taskNo, agentMeta.get(again)?.type ?? e.subagentType))
      }
      return resumed
    }
    const text = `${e.description} ${e.prompt}`
    const opts = normalize(await read($, options))
    const front = e.fork ? null : await frontOf($, e.subagentType)
    const callEffort = callEfforts.get(e.tool_use_id)
    callEfforts.delete(e.tool_use_id)
    let who = whoSets({
      callModel: e.model,
      callEffort,
      front,
      builtin: isBuiltin(e.subagentType),
      fork: e.fork,
      envModel: env.force,
      envEffort: env.effort,
    })
    const pick = pickRoute({ text, tools: [], subagentType: e.subagentType, creative: opts.creative })
    // Subagents never start on Opus (or Fable) unless they plan: execution is Sonnet or Haiku
    const spawnModel = (pick.model === 'opus' || pick.model === 'fable') && !isPlanner(e.subagentType) ? 'sonnet' : pick.model
    // Orchestrator off: a locked session stays locked, subagents included. One that nothing sets inherits the parent's
    // model (until /cr-unlock); a parent id the router does not know is inherited too. Orchestrator on: the session is
    // the orchestrator, so a subagent that nothing sets is routed like any other.
    const parentFamily = familyOf(e.parentModel)
    const parentLocked = parentFamily === null || opts.locks.includes(parentFamily)
    const inherit = isRouted(who.model) && parentLocked && opts.orchestrator === 'off'
    if (inherit) who = { model: 'default', effort: isRouted(who.effort) ? 'default' : who.effort }
    const sendModel = isRouted(who.model) ? spawnModel : inherit ? e.parentModel : e.model
    const result = await next(sendModel === e.model ? e : { ...e, model: sendModel })
    if (result.deny) return result

    if (result.agentId) subagents.set(result.agentId, { text, subagentType: e.subagentType, who })
    const agent: Agent = {
      id: result.agentId ?? null,
      name: e.description || e.subagentType,
      type: e.subagentType,
      by: who,
      role: roleOf(e.subagentType, text),
      model: result.model ?? null,
      // What the file or the call asked for; the first request replaces it with what the engine sent
      effort: toLevel(callEffort) ?? toLevel(front?.effort),
      status: 'running',
      startedAt: await $.clock.now(),
      seconds: null,
      tokens: 0,
      tokensIn: 0,
      tokensCached: 0,
      tokensOut: 0,
    }
    await update($, tasks, list => attachAgent(list, turnId, agent))
    if (result.agentId) {
      const named = skillsNamed(e.prompt)
      agentMeta.set(result.agentId, { n: taskNo, type: e.subagentType, model: result.model, named, maxTurns: Number(front?.maxTurns) > 0 ? Number(front?.maxTurns) : null, steps: 0 })
      await emit($, launchLine(await $.clock.now(), taskNo, { id: result.agentId, type: e.subagentType, model: result.model, effort: agent.effort, by: who, brief: e.prompt, skills: named }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Runs when a turn ends, for the main conversation and for each subagent
  on('turn.complete', async ($, e, next) => {
    const tokens = e.usage ? e.usage.input_tokens + e.usage.output_tokens : 0
    // What the turn was billed for, split: prompt tokens fresh (input + cache writes), prompt tokens the cache served, output
    const split = {
      tokensIn: e.usage ? e.usage.input_tokens + (e.usage.cache_creation_input_tokens ?? 0) : 0,
      tokensCached: e.usage?.cache_read_input_tokens ?? 0,
      tokensOut: e.usage?.output_tokens ?? 0,
      tokensWrite: e.usage?.cache_creation_input_tokens ?? 0,
    }
    const status = e.reason === 'error' ? 'failed' : 'done'
    const seconds = e.durationMs / 1000
    const agentId = e.agentId
    await update($, totals, t => ({ tokens: t.tokens + tokens, turns: t.turns + (agentId ? 0 : 1) }))
    // The log: an agent's end (tokens, cost, time, turns, how it ended) and a verifier's verdict; the main thread's turn
    {
      const at = await $.clock.now()
      const model = e.usage?.model ?? ''
      const cost = await costNow($, model, split)
      const meta = agentId ? agentMeta.get(agentId) : undefined
      if (agentId && reviewJobs.has(agentId)) {
        const out = reviewJobs.get(agentId) ?? ''
        reviewJobs.delete(agentId)
        if (out && e.answer.trim()) {
          await $.fs.write(out, e.answer).catch(() => undefined)
          $.ui.toast(`ClaudeRouter: review written to ${out}`)
        }
      } else if (agentId && meta) {
        const how: End = e.reason === 'error' ? 'failed' : meta.maxTurns !== null && meta.steps >= meta.maxTurns ? 'maxTurns' : 'ended'
        await emit($, endLine(at, meta.n, { id: agentId, agent: meta.type, model: model || meta.model, in: split.tokensIn, cached: split.tokensCached, out: split.tokensOut, cost, sec: seconds, turns: meta.steps, end: how }))
        if (/(^|:)verifier$/i.test(meta.type)) await emit($, verdictLine(at, meta.n, { id: agentId, ...(meta.handback ?? verdictOf(e.answer)) }))
      } else if (!agentId) {
        await emit($, mainLine(at, taskNo, { model: model || '—', effort: (await read($, route))?.effort ?? null, in: split.tokensIn, cached: split.tokensCached, out: split.tokensOut, cost, sec: seconds }))
      }
    }

    if (agentId) {
      await update($, tasks, list => patchAgent(list, agentId, { status, seconds, tokens, ...split }))
    } else {
      busy = false
      const own = taskOf(e.turnId)
      // A continued task adds the turn to what it already spent
      await update($, tasks, list => list.map(t => t.id !== own ? t : own === e.turnId ? { ...t, status, seconds, tokens, ...split } : {
        ...t,
        status,
        seconds: (t.seconds ?? 0) + seconds,
        tokens: (t.tokens ?? 0) + tokens,
        tokensIn: (t.tokensIn ?? 0) + split.tokensIn,
        tokensCached: (t.tokensCached ?? 0) + split.tokensCached,
        tokensOut: (t.tokensOut ?? 0) + split.tokensOut,
        tokensWrite: (t.tokensWrite ?? 0) + split.tokensWrite,
      }))
      aliases.delete(e.turnId)
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
    // Closed: nothing above the prompt until `/cr-band full` (or `route`)
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
        void $.ui.toast('ClaudeRouter band closed. /cr-band full brings it back (or /cr).')
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
