import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Agent, Effort, Model, Route, Task, Who } from '../types'
import { JEV_TIMEOUT_MS, type JevPick, askJev } from './jev'
import { DEFAULT_OPTIONS, OPTION_ALIASES, OPTION_COMMANDS, WARM_AUTO, WARM_DEFAULT_MS, WARM_EVERY_MS, WARM_MAX_MS, applyArgs, normalize, sizeText } from './options'
import { type Pin, directiveOf, guard, managerVerdict, toLevel } from './guard'
import { type End, type Line, type LogPaths, REVIEW_AGENT, blockLine, clip, dateOf, endLine, envLogPaths, fallbackLine, followLine, fromJsonl, isAbsoluteDir, isTempCwd, launchLine, legacyDir, legacyLogPaths, mainLine, mcpLine, mdAll, mdOf, pathsIn, probeLine, projectLogPaths, projectName, reviewPrompt, rowsOf, sessionIds, sessionLine, skillLine, skillsNamed, stamp, taskLine, toJsonl, verdictLine, verdictOf, warmLine, workflowLine } from './sessionlog'
import { type EnvFacts, type Front, type Io, agentDirs, costOf, deckText, effortForHeld, envFacts, envWarnings, findFront, isBuiltin, isRouted, mergePrices, parsePrices, pricesEmpty, whoSets } from './orchestrate'
import { type Els, type Snapshot, drawBand, drawStrip } from './band'
import { drawPane } from './pane'
import { type Anim, animCells } from './pixel'
import { MODEL_IDS, carriesOn, creativeFloor, creativeOf, effortFor, familyOf, idFor, isPlanner, pickRoute, roleOf } from './route'
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
// The locked model id the router itself last sent on the main thread (Fable for flagship creative work, by default;
// /cr-creative opus turns it off). A request arriving on that id is the router's own choice, not the user's,
// so the lock does not freeze it there.
let routedLocked: string | null = null
// When the main thread last sent a request, for keep-warm
let lastRequestAt: number | null = null
// When busy went true, and when the main thread last stepped: a turn that never completes (a failure the host did not
// report as complete) must not hold busy, and so the pings, forever
let busySince = 0
let lastStepAt = 0
const BUSY_STUCK_MS = 20 * 60 * 1000
// Keep-warm skips already logged in this idle period (one line per reason), and the idle period they belong to
const skipLogged = new Set<string>()
let skipPeriod: number | null = null
let idleSince: number | null = null
// Keep-warm window events in the log: t 'warm' with an `event` field (armed, closed, ping-failed, skipped, heartbeat).
// Ping and skip lines (no `event`) keep their shape. Only counts, timings and reason codes, never text.
const HEARTBEAT_MS = 10 * 60 * 1000
let lastHeartbeatAt: number | null = null
// The warmUntil whose end was already logged as a closed event
let closedLogged = 0
// Auto-arm: the deadline of the window the router opened itself (0 = none; a manual /cr-warm clears it, so only an auto window rolls),
// and whether /cr-warm off ended auto-arm for this session
let autoUntil = 0
let autoOff = false
const warmEvent = (at: number, n: number, event: string, facts: Record<string, string | number | boolean>): Line => ({ t: 'warm', at, n, event, ...facts })
// An error's class name only, never its message
const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err).replace(/[^\w.-]/g, '').slice(0, 40) || 'unknown'
// Fable is out of usage: until this time (ms) every Fable request is sent as Opus. The model id the main thread last sent
// says which model a rate-limit failure belongs to.
let fableOut: { until: number; clock: string; note: string } | null = null
let lastMainModel = ''
const FABLE_OUT_DEFAULT_MS = 60 * 60 * 1000
// Two rate-limit failures on Fable within 10 minutes, with no sign of a usage cap, hold Opus for 15 minutes
const FABLE_REPEAT_WINDOW_MS = 10 * 60 * 1000
const FABLE_REPEAT_HOLD_MS = 15 * 60 * 1000
const PROBE_EVERY_MS = 10 * 60 * 1000
let lastFableLimitAt: number | null = null
let lastProbeAt: number | null = null
const FABLE_OUT_WARNING = 'Fable out of usage · Opus until '
// The error details are read for words only, never kept: "usage", "limit" or "quota" without "overloaded" or "try again"
const looksLikeUsageCap = (details: unknown): boolean => typeof details === 'string' && /usage|limit|quota/i.test(details) && !/overloaded|try again/i.test(details)
const detailsLength = (details: unknown): number | null => (typeof details === 'string' ? details.length : null)
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
// The Workflow the main thread last launched this task ('' when its input names none), or null when none has run
let currentWorkflow: string | null = null
// A main-thread turn woken by a sub-agent's hand-back continues the task it belongs to: its turn id points at that task
const aliases = new Map<string, string>()
const taskOf = (id: string) => aliases.get(id) ?? id
// The text a hand-back turn starts with: the engine's agent-message envelope, not something you typed
const HAND_BACK = /^\s*<[^>]*agent-message/i
// The session log (see sessionlog.ts): its lines so far, where they go, the number of the current task, and what is known
// of each running agent. A reload re-reads the file named by the logfile atom.
let logLines: Line[] = []
let logPath: LogPaths | null = null
// This session's id (the key of its rows in the shared log), its project name, whether its log is still in the spare
// folder, and the CR_LOG_DIR override
let logSid = 'session'
let logProject = ''
let logSpare = false
let logDirEnv = ''
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

// The project's log is shared by every session in it: a row is appended to the file as it is now (read, add, write), never
// written from this session's memory alone, so a session running at the same time keeps its own rows. Writes of one session
// are chained so they cannot overtake each other. False when the file could not be written (or could not be read whole).
let writeChain: Promise<unknown> = Promise.resolve()
async function appendRows($: EngineInterface, jsonl: string, rows: readonly Line[]): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    let text = await $.fs.read(jsonl).then(t => (typeof t === 'string' ? t : null), () => null)
    // A file that exists but cannot be read is left alone: writing over it would lose every other session's rows
    if (text === null && (await $.fs.exists(jsonl).catch(() => false))) return false
    text ??= ''
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    return $.fs.write(jsonl, text + toJsonl(rows)).then(() => true, () => false)
  }
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => undefined)
  return next
}
// Appends one line to the session log, from named fields only (see the constructors in sessionlog.ts), tagged with the session id
async function emit($: EngineInterface, line: Line): Promise<boolean> {
  if (!logPath) return false
  const row = { ...line, sid: clip(logSid, 60) }
  logLines.push(row)
  return appendRows($, logPath.jsonl, [row])
}
// The part of a legacy log file's name that identifies its session: the name without its "date-hhmm-" stamp
const idOf = (f: string) => f.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/\.jsonl$/, '')
// Every row of the project's log, oldest first; when it has none, the per-session files of earlier versions in the home
// fallback folder (their rows get the session id from the file name)
async function allRows($: EngineInterface): Promise<{ rows: Line[]; files: string[] }> {
  if (!logPath) return { rows: [], files: [] }
  const text = await $.fs.read(logPath.jsonl).then(t => (typeof t === 'string' ? t : ''), () => '')
  const rows = fromJsonl(text)
  // This session's own rows do not count: the log has "no rows" while no other session has written to it
  if (rows.some(r => r.sid !== logSid) || !home) return { rows, files: [logPath.jsonl] }
  const dir = legacyDir(home, sessionCwd)
  const files = (await sessionFiles($, dir)).filter(f => f !== 'cr-log.jsonl')
  const out: Line[] = []
  for (const f of files) {
    const body = await $.fs.read(`${dir}/${f}`).then(t => (typeof t === 'string' ? t : ''), () => '')
    out.push(...fromJsonl(body).map(r => ({ ...r, sid: idOf(f) })))
  }
  if (out.length === 0) return { rows, files: [logPath.jsonl] }
  return { rows: [...out, ...rows], files: files.map(f => `${dir}/${f}`) }
}
// The readable view, rebuilt from the whole shared log (this session's rows when it cannot be read)
async function writeMd($: EngineInterface, at: number): Promise<void> {
  if (!logPath) return
  const text = await $.fs.read(logPath.jsonl).then(t => (typeof t === 'string' ? t : ''), () => '')
  const rows = fromJsonl(text)
  await $.fs.write(logPath.md, mdAll(rows.length > 0 ? rows : logLines, at)).catch(() => undefined)
}
// False when $.session.id() failed and the session runs under a made-up id: such a log is never continued
let sessionKnown = true

// <cwd>/.claude/.gitignore: ignores the log files unless something already does. The project's own .gitignore is only read.
async function ignoreLog($: EngineInterface, cwd: string): Promise<void> {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const read = (path: string) => $.fs.read(path).then(t => (typeof t === 'string' ? t : null), () => null)
  const all = String.raw`\*|\.claude\/?|\.claude\/\*`
  const has = (text: string | null, rule: string) => text !== null && new RegExp(`^\\s*\\/?(${rule})\\s*$`, 'm').test(text)
  // Both log files covered (cr-log.*, or both exact names), checked apart from the reviews folder
  const logsIn = (text: string | null) => has(text, `${all}|(\\.claude\\/)?cr-log\\.\\*`) || (has(text, '(\\.claude\\/)?cr-log\\.md') && has(text, '(\\.claude\\/)?cr-log\\.jsonl'))
  const reviewsIn = (text: string | null) => has(text, `${all}|(\\.claude\\/)?cr-reviews\\/?`)
  const mineAt = `${root}/.claude/.gitignore`
  const mine = await read(mineAt)
  // A file that exists but cannot be read is left alone: writing over it would lose its rules
  if (mine === null && (await $.fs.exists(mineAt).catch(() => false))) return
  const top = await read(`${root}/.gitignore`)
  const rules = [...(logsIn(mine) || logsIn(top) ? [] : ['cr-log.*']), ...(reviewsIn(mine) || reviewsIn(top) ? [] : ['cr-reviews/'])]
  if (rules.length === 0) return
  await $.fs.write(mineAt, `${mine === null || mine === '' ? '' : mine.replace(/\s*$/, '\n')}${rules.join('\n')}\n`).catch(() => undefined)
}

// Where a session's log goes: CR_LOG_DIR wins; a temp or spare-* folder (or no folder) uses the home fallback;
// anything else the project's own .claude folder
function chooseLog(cwd: string): { paths: LogPaths | null; spare: boolean; project: boolean } {
  if (logDirEnv) return { paths: envLogPaths(logDirEnv), spare: false, project: false }
  if (cwd.trim() !== '' && !isTempCwd(cwd)) return { paths: projectLogPaths(cwd), spare: false, project: true }
  return { paths: home ? legacyLogPaths(home, cwd) : null, spare: true, project: false }
}

// A session that started in a temp folder is logged in the home fallback under "spare-XXXX". When a later turn reports a
// real project folder, its rows are appended to that project's log (never overwriting it), and are then taken out of the
// spare file (the mod has no way to delete a file). Where the append fails, the log stays in the spare folder.
async function renameSpare($: EngineInterface, cwd: unknown): Promise<void> {
  if (!logPath || !logSpare || typeof cwd !== 'string' || cwd.trim() === '' || isTempCwd(cwd)) return
  const old = logPath
  const real = projectName(cwd)
  const existing = fromJsonl(await $.fs.read(projectLogPaths(cwd).jsonl).then(t => (typeof t === 'string' ? t : ''), () => ''))
  const offset = sessionKnown ? rowsOf(existing, logSid).filter(l => l.t === 'task').length : 0
  const ours = logLines.map(l => {
    const moved = l.t === 'session' && l.phase === 'start' ? { ...l, project: real } : l
    return offset > 0 && typeof moved.n === 'number' ? { ...moved, n: moved.n + offset } : moved
  })
  let target = projectLogPaths(cwd)
  if (await appendRows($, target.jsonl, ours)) await ignoreLog($, cwd)
  else {
    // The project folder cannot be written: the home fallback under the real name
    if (!home) return
    target = legacyLogPaths(home, cwd)
    if (target.jsonl === old.jsonl || !(await appendRows($, target.jsonl, ours))) return
  }
  logPath = target
  logLines = ours
  logSpare = false
  logProject = real
  taskNo += offset
  for (const meta of agentMeta.values()) meta.n += offset
  const rest = fromJsonl(await $.fs.read(old.jsonl).then(t => (typeof t === 'string' ? t : ''), () => '')).filter(l => l.sid !== logSid)
  await $.fs.write(old.jsonl, toJsonl(rest)).catch(() => undefined)
  const file = target.jsonl
  await update($, logfile, () => file)
}
const GENERAL_WARNING = 'general-purpose launched: use a roster agent'
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

// Whether the main conversation already holds the rules note (a resumed session): session.start carries no resume flag,
// so the conversation itself is read back. A conversation that cannot be read counts as not holding them.
const RULES_OPEN = '<orchestrator-rules source='
async function holdsRules($: EngineInterface): Promise<boolean> {
  try {
    const messages: unknown = await $.session.messages({})
    return Array.isArray(messages) && messages.some(m => m?.role === 'user' && typeof m.text === 'string' && m.text.trimStart().startsWith(RULES_OPEN))
  } catch {
    return false
  }
}

// The rules could not be put into the conversation: the orchestrator goes off for the session, so the guard never
// blocks the main thread with no rules loaded to explain why
async function rulesFailed($: EngineInterface, why: string): Promise<void> {
  await update($, options, o => ({ ...normalize(o), orchestrator: 'off' as const, rules: null }))
  $.ui.toast(`ClaudeRouter: orchestrator off: the rules could not be loaded (${why})`)
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
  const { warmUntil, ultracode, ultraMax } = normalize(await read($, options))
  return {
    ultracode,
    ultraMax,
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
    mode: normalize(await read($, options)).mode,
    now,
    frame,
    terminal: surface === 'terminal',
    columns,
    rows,
    anim: [],
  }
}

// The /cr-* commands as functions of their arguments: the runtime commands (command.run) and the file-based stubs in
// commands/ (expanded through skill.prompt, see runMarker) both call these, so both run the same code.
type Reply = { text?: string }

// /cr-<option>: /cr-warm 2h is the option 'warm' with the argument '2h'
async function runOption($: EngineInterface, sub: string, args: string): Promise<Reply> {
  const now = await $.clock.now()
  const current = normalize(await read($, options))
  const { next, text } = applyArgs(`${sub} ${args}`, current, now)
  // Turning the orchestrator on needs its rules: a missing file is said, not confirmed
  if (sub === 'orchestrator' && next && next.orchestrator !== 'off') {
    const rules = await loadRules($)
    if (rules === null) return { text: `orchestrator not turned on: the rules file is missing or empty: ${rulesPath()}. Create it, then run the command again.` }
    const size = byteLength(rules)
    // Already loaded in this conversation (on to hands on, or the reverse): do not load them twice
    const failed = current.orchestrator !== 'off' && current.rules !== null ? null : await injectRules($, rules)
    if (failed !== null) {
      await rulesFailed($, failed)
      return { text: `orchestrator: off · rules NOT loaded (${failed})` }
    }
    await update($, options, () => ({ ...next, rules: size }))
    return { text: next.orchestrator === 'on' ? `orchestrator: on · manager only · rules loaded (${sizeText(size)})` : `orchestrator: hands on · guard off · rules loaded (${sizeText(size)})` }
  }
  if (next) await update($, options, () => next)
  // Keep-warm window armed, re-armed or closed by hand: one event line
  if (sub === 'warm' && next) {
    // A command takes the window over from auto-arm; "off" also ends auto-arm for the rest of the session
    autoUntil = 0
    if (args.trim().toLowerCase() === 'off') autoOff = true
    if (next.warmUntil > now) {
      lastHeartbeatAt = now
      await emit($, warmEvent(now, taskNo, 'armed', { via: 'command', until: next.warmUntil, minutes: Math.round((next.warmUntil - now) / 60_000) }))
    } else if (current.warmUntil > now) {
      lastHeartbeatAt = null
      await emit($, warmEvent(now, taskNo, 'closed', { reason: 'off', until: current.warmUntil }))
    }
  }
  // /cr-fable reset and /cr-fable off: the fallback ends now
  if (sub === 'fable' && ['reset', 'off'].includes(args.trim().toLowerCase())) {
    fableOut = null
    lastFableLimitAt = null
    await update($, warnings, list => list.filter(w => !w.startsWith(FABLE_OUT_WARNING)))
  }
  return { text }
}

// /cr-deck: the same deck the pane draws, as text with exact figures
async function runDeck($: EngineInterface, args: string): Promise<Reply> {
  await loadPrices($)
  const list = await read($, tasks)
  return { text: deckText(args.trim() === 'last' ? list.slice(-1) : list, await read($, prices)) }
}

// /cr-log: the session log as a table. "last" reads the previous session's file instead.
async function runLog($: EngineInterface, args: string): Promise<Reply> {
  if (!logPath) return { text: 'session log: off (no home folder found)' }
  const now = await $.clock.now()
  if (args.trim() !== 'last') return { text: `${mdOf(logLines, now)}\n${logPath.jsonl}` }
  // "last" is the session before this one in the project's log
  const { rows, files } = await allRows($)
  const previous = sessionIds(rows).filter(id => id !== logSid).at(-1)
  if (!previous) return { text: 'no earlier session log for this project' }
  return { text: `${mdOf(rowsOf(rows, previous))}\n${files.length === 1 ? files[0] : (files.find(f => f.includes(previous)) ?? files[0])}` }
}

// /cr-review [n]: one Sonnet agent at medium effort reads the last n logs of this project and reports.
// The hook writes its answer to reviews/<date>.md; nothing is edited.
async function runReview($: EngineInterface, args: string): Promise<Reply> {
  if (!logPath) return { text: 'session log: off (no home folder found)' }
  const asked = Number.parseInt(args.trim(), 10)
  const count = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 50) : 10
  // The shared log holds every session: the agent is told which last n session ids to read. Earlier versions' per-session files are read only when it has no rows.
  const { rows, files: all } = await allRows($)
  const ids = sessionIds(rows).slice(-count)
  if (ids.length === 0) return { text: 'no session logs for this project yet' }
  const legacy = all.length !== 1 || all[0] !== logPath.jsonl
  const files = legacy ? all.filter(f => ids.some(id => f.includes(id))) : all
  const at = await $.clock.now()
  const taken = await $.fs.exists(`${logPath.reviews}/${dateOf(at)}.md`).catch(() => false)
  const out = `${logPath.reviews}/${taken ? stamp(at) : dateOf(at)}.md`
  const started = await $.agent.spawn({ prompt: reviewPrompt(files, logProject, legacy ? [] : ids), description: 'Review session logs', subagentType: `${$.plugin.name}:${REVIEW_AGENT}`, model: 'sonnet' })
  if (started.deny || !started.agentId) return { text: `review not started: ${started.deny ?? 'no agent id'}` }
  reviewJobs.set(started.agentId, out)
  return { text: `review started on ${files.length} log${files.length === 1 ? '' : 's'}: sonnet, medium, Read and Grep only. It will be written to ${out}; it changes nothing.` }
}

// /cr-prices: reloads the table and says what is filled in
async function runPrices($: EngineInterface): Promise<Reply> {
  await loadPrices($)
  const table = await read($, prices)
  if (pricesEmpty(table)) return { text: 'prices missing: fill in prices.json in the plugin folder, or ~/.claude/clauderouter-prices.json (USD per million tokens), then /cr-prices' }
  return { text: Object.entries(table).map(([m, p]) => `${m}: input ${p?.input ?? '—'} · output ${p?.output ?? '—'} · cache write ${p?.cacheWrite ?? '—'} · cache read ${p?.cacheRead ?? '—'}`).join('\n') }
}

// /cr: opens the pane. Opening it draws nothing by itself; ui.render fills it.
async function runPane($: EngineInterface): Promise<Reply> {
  // A bare /cr also brings back a band that was closed with the ✕, so it can never be lost
  const o = normalize(await read($, options))
  const restored = o.band === 'off'
  if (restored) await update($, options, () => ({ ...o, band: 'full' as const }))
  await $.ui.open({ id: PANE, title: 'ClaudeRouter', rows: 24, closeOnEscape: true })
  return restored ? { text: 'ClaudeRouter band restored: /cr-band off closes it' } : {}
}

// File-based stubs: commands/cr-<name>.md expands to the line "[cr-cmd] cr-<name> <arguments>" for sessions that list only
// file commands (claude.ai project threads, Remote Control). skill.prompt sees the expanded text; runMarker runs the same
// function as the runtime command and the text the model gets is replaced by the reply, to be printed verbatim.
// /cr (the pane) has no text form: its stub runs cr-status.
const MARKER = /^\[cr-cmd\][ \t]+(cr(?:-[a-z]+)?)[ \t]*(.*)$/m
export function markerOf(text: string): { command: string; args: string } | null {
  const m = MARKER.exec(text)
  if (!m) return null
  // An engine that did not substitute $ARGUMENTS leaves it literal: that is no argument
  const args = (m[2] ?? '').replace(/\$ARGUMENTS/g, '').trim()
  return { command: m[1] === 'cr' ? 'cr-status' : m[1], args }
}

async function runCommand($: EngineInterface, command: string, args: string): Promise<Reply | null> {
  const option = COMMANDS.find(([name]) => `cr-${name}` === command)
  if (option) return runOption($, option[1], args)
  if (command === 'cr-deck') return runDeck($, args)
  if (command === 'cr-log') return runLog($, args)
  if (command === 'cr-review') return runReview($, args)
  if (command === 'cr-prices') return runPrices($)
  return null
}

const replyPrompt = (command: string, args: string, reply: string) =>
  `ClaudeRouter ran /${command}${args ? ` ${args}` : ''} itself; nothing else is needed. Print the reply below to the user verbatim, inside one code block, and add nothing else: no tool call, no comment.\n\n<cr-reply command="${command}">\n${reply}\n</cr-reply>`

async function runMarker($: EngineInterface, text: string): Promise<string | null> {
  const marker = markerOf(text)
  if (!marker) return null
  let reply: Reply | null
  try {
    reply = await runCommand($, marker.command, marker.args)
  } catch (error) {
    reply = { text: `/${marker.command} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (reply === null) return replyPrompt(marker.command, marker.args, `unknown ClaudeRouter command: /${marker.command}`)
  return replyPrompt(marker.command, marker.args, reply.text?.trim() ? reply.text : '(done, no output)')
}

export const register: Register = on => {
  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    fableOut = null
    lastFableLimitAt = null
    lastProbeAt = null
    lastMainModel = ''
    busy = false
    busySince = 0
    lastStepAt = 0
    skipLogged.clear()
    skipPeriod = null
    idleSince = null
    autoUntil = 0
    autoOff = false
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
      if (rules === null) {
        // On by default, but with no rules file there is nothing to manage by: off, said once
        await update($, options, o => ({ ...normalize(o), orchestrator: 'off' as const, rules: null }))
        $.ui.toast(`ClaudeRouter: orchestrator off: the rules file is missing or empty (${rulesPath()})`)
      } else {
        // A resumed conversation already holds the rules: noted as loaded, not injected a second time
        const failed = (await holdsRules($)) ? null : await injectRules($, rules)
        if (failed === null) await update($, options, o => ({ ...normalize(o), rules: byteLength(rules) }))
        else await rulesFailed($, failed)
      }
    }
    // The session log: the project's shared log (see chooseLog), this session's rows continued when a reload or the same session id has some
    logDirEnv = await $.env.get('CR_LOG_DIR').then(v => (typeof v === 'string' && isAbsoluteDir(v) ? v.trim() : ''), () => '')
    const chosen = chooseLog(e.cwd)
    if (chosen.paths) {
      const prior = await read($, logfile)
      const gotId = await $.session.id().then(v => (typeof v === 'string' && v.trim() !== '' ? v : null), () => null)
      sessionKnown = gotId !== null
      logProject = projectName(e.cwd)
      logSpare = chosen.spare
      const at = await $.clock.now()
      if (prior) {
        const dir = prior.slice(0, prior.lastIndexOf('/'))
        logPath = pathsIn(dir, dir.endsWith('/.claude') ? `${dir}/cr-reviews` : `${dir}/reviews`)
        logSpare = /\/cr-logs\/spare-[^/]*$/i.test(dir)
        const rows = fromJsonl(await $.fs.read(prior).then(t => (typeof t === 'string' ? t : ''), () => ''))
        // An id that cannot be read is no id: a reload goes on with the last session in the file, a new session gets an id of its own
        logSid = clip(gotId ?? sessionIds(rows).at(-1) ?? `session-${at}`, 60)
        logLines = rowsOf(rows, logSid)
        taskNo = logLines.filter(l => l.t === 'task').length
      } else {
        logPath = chosen.paths
        logSid = clip(gotId ?? `session-${at}`, 60)
        // One log per project: this session id's rows already in it are continued, not duplicated
        logLines = sessionKnown ? rowsOf(fromJsonl(await $.fs.read(logPath.jsonl).then(t => (typeof t === 'string' ? t : ''), () => '')), logSid) : []
        taskNo = logLines.filter(l => l.t === 'task').length
        if (chosen.project) await ignoreLog($, e.cwd)
        const start = sessionLine(at, 'start', logProject, await mode$($))
        // The project folder (or the CR_LOG_DIR folder) cannot be written: the home fallback, with the same row
        if (!(await emit($, start)) && (chosen.project || logDirEnv) && home) {
          logPath = legacyLogPaths(home, e.cwd)
          await appendRows($, logPath.jsonl, logLines.slice(-1))
        }
        const file = logPath.jsonl
        await update($, logfile, () => file)
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
    // Keep-warm: once a minute, ping the cache if the window is open and the main thread has been idle for WARM_EVERY_MS (4 min by default)
    $.clock.every(60_000, async () => {
      const now = await $.clock.now()
      const { warmUntil } = await read($, options)
      // The clock row counts in minutes: redraw once a minute while a window is open
      if (warmUntil > now) $.ui.invalidate('ui.render')
      // A turn that never completed and shows no step for 20 min is not running: clear busy so the pings go on
      if (busy && now - Math.max(busySince, lastStepAt) > BUSY_STUCK_MS) busy = false
      // The idle period is counted from the last main-thread request; with none yet, from the first tick that saw none
      if (lastRequestAt === null && idleSince === null) idleSince = now
      const idleFrom = lastRequestAt ?? idleSince ?? now
      if (skipPeriod !== idleFrom) { skipLogged.clear(); skipPeriod = idleFrom }
      // A window that ran out of time is logged once, by the first tick that sees it (a failed ping or /cr-warm off logs its own)
      if (warmUntil > 0 && warmUntil <= now && closedLogged !== warmUntil) {
        closedLogged = warmUntil
        lastHeartbeatAt = null
        await emit($, warmEvent(now, taskNo, 'closed', { reason: 'deadline', until: warmUntil }))
      }
      if (warmUntil > now && !busy) {
        // Heartbeat: every 10 min while the window is open and idle, so a missing ping can be told from a dead tick
        if (lastHeartbeatAt === null) lastHeartbeatAt = now
        else if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
          lastHeartbeatAt = now
          await emit($, warmEvent(now, taskNo, 'heartbeat', {
            alive: true,
            idleSec: Math.max(0, Math.round((now - idleFrom) / 1000)),
            secToNextPing: Math.max(0, Math.round((idleFrom + WARM_EVERY_MS - now) / 1000)),
            minutesLeft: Math.round((warmUntil - now) / 60_000),
            hasRequest: lastRequestAt !== null,
          }))
        }
      }
      // The ping is due once WARM_EVERY_MS has passed since then; a window that never opened (warm off) has nothing to skip
      const due = now - idleFrom >= WARM_EVERY_MS
      const skip = warmUntil <= now ? (warmUntil > 0 ? 'window-closed' as const : null) : busy ? 'busy' as const : lastRequestAt === null ? 'no-request' as const : null
      if (skip) {
        // No silent skip: say why the due ping was not sent, once per reason per idle period
        if (due && !skipLogged.has(skip)) {
          skipLogged.add(skip)
          await emit($, warmLine(now, taskNo, { minutesLeft: (warmUntil - now) / 60_000, ok: false, skip }))
        }
        return
      }
      if (!due || warmUntil <= now) {
        // Not due yet: said once per idle period (the first tick after a ping or a request), then silent
        if (!due && warmUntil > now && !skipLogged.has('not-due')) {
          skipLogged.add('not-due')
          await emit($, warmEvent(now, taskNo, 'skipped', { reason: 'not-due', secToNextPing: Math.max(0, Math.round((idleFrom + WARM_EVERY_MS - now) / 1000)), minutesLeft: Math.round((warmUntil - now) / 60_000) }))
        }
        return
      }
      // The fork re-sends the main thread's last request (its model, effort, system, tools) with the prompt after it:
      // it takes no model or effort of its own, so it shares the main cache by construction
      let failure = null as unknown
      const reply = await $.model.fork({ prompt: 'Reply with the single word: warm' }).catch((err: unknown) => { failure = err ?? 'unknown'; return null })
      // A failed ping ends the window: the cache is probably gone, and retrying would only pay to write it again
      const ok = Boolean(reply?.isAnswered)
      // The log keeps the time, the minutes left in the window and the fork's token counts, never the ping's text.
      // cached (cache read) near zero with a large write: the fork did not share the main prefix.
      const u = (reply as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | null)?.usage
      const counts = u
        ? { cached: u.cache_read_input_tokens ?? 0, written: u.cache_creation_input_tokens ?? 0, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, model: lastMainModel }
        : { usage: 'none' as const, model: lastMainModel }
      await emit($, warmLine(now, taskNo, { minutesLeft: (warmUntil - now) / 60_000, ok, ...counts }))
      if (!ok) {
        await emit($, warmEvent(now, taskNo, 'ping-failed', { error: failure === null ? 'not-answered' : errorClass(failure) }))
        await emit($, warmEvent(now, taskNo, 'closed', { reason: 'failed-ping', until: warmUntil }))
        lastHeartbeatAt = null
        autoUntil = 0
        await update($, options, o => ({ ...o, warmUntil: 0 }))
      } else lastRequestAt = now
    })
    return next(e)
  })

  // Runs when you type /cr-<option>: /cr-warm 2h is the option 'warm' with the argument '2h'
  for (const [name, sub] of COMMANDS) {
    on('command.run', { command: `cr-${name}` }, async ($, e) => runOption($, sub, e.args)).catch(($, e, next) => next(e))
  }

  // Runs when you type /cr-deck, /cr-log, /cr-review [n]
  on('command.run', { command: 'cr-deck' }, async ($, e) => runDeck($, e.args))
  on('command.run', { command: 'cr-log' }, async ($, e) => runLog($, e.args))
  on('command.run', { command: 'cr-review' }, async ($, e) => runReview($, e.args))

  // Runs when the session ends: the closing line, and the readable summary next to the log
  on('session.end', async ($, e, next) => {
    if (logPath) {
      const at = await $.clock.now()
      await emit($, sessionLine(at, 'end', logProject, await mode$($)))
      await writeMd($, at)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Runs when you type /cr-prices, and /cr
  on('command.run', { command: 'cr-prices' }, async ($) => runPrices($))
  on('command.run', { command: 'cr' }, async ($) => runPane($))

  // Runs when a turn begins: a new task row, named by the prompt
  on('turn.start', async ($, e, next) => {
    // A sub-agent's own run is not a task: its row is the agent under the task that spawned it
    if (e.agentId) return next(e)
    busy = true
    busySince = await $.clock.now()
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
    // An empty prompt is not a logged task (it would be a junk row)
    const logged = e.text.trim() !== ''
    if (logged) taskNo += 1
    // "ultracode" in the prompt: only noted. The person turns it on; the mod never does.
    const ultra = /\bultracode\b/i.test(e.text)
    currentWorkflow = null
    // A new task clears the last task's general-purpose warning
    await update($, warnings, list => list.filter(w => w !== GENERAL_WARNING))
    // A spare-* session whose turn now reports a real project folder moves its log under that project's name
    await renameSpare($, (e as { cwd?: unknown }).cwd)
    // The folder the turn runs in is the project the manager guard allows its project files in
    const reported = (e as { cwd?: unknown }).cwd
    if (typeof reported === 'string' && reported.trim() !== '') sessionCwd = reported
    if (logged) await emit($, taskLine(await $.clock.now(), taskNo, e.text, await mode$($), ultra))
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
      ultra,
      workflowAgents: 0,
      agents: [],
    }
    await update($, tasks, list => [...list.slice(-19), task])
    return next(e)
  })

  // Runs before each request to the model: picks the model and effort, then records what was chosen
  // A main-thread request that failed on a rate limit while it ran on Fable: Fable is out. Opus carries the session until
  // the reset time (a rate-limit window at 100% that says when it resets), else an hour. The engine offers no way to retry
  // from here, so the next request is the retry. Only the error's kind is read, never its text.
  // It only triggers when the failure looks like a usage cap: a rate-limit window at 100%, or details that say usage, limit
  // or quota. A plain 429 triggers nothing the first time; a second within 10 minutes holds Opus for 15 minutes.
  // The engine's signal is not confirmed yet: a `probe` log line records each failure's shape (never its text).
  on('classic.StopFailure', async ($, e, next) => {
    // A failed main turn may never reach turn.complete: it is over, so it no longer holds the pings back
    if (!e.agent_id) busy = false
    const now = await $.clock.now()
    const spent = await $.session.usage().then(u => u.rateLimits, () => [])
    const details = (e as { error_details?: unknown }).error_details
    await emit($, probeLine(now, { source: 'failure', code: typeof e.error === 'string' ? e.error : null, detailsLen: detailsLength(details), who: e.agent_id ? 'agent' : 'main', family: familyOf(lastMainModel), limits: spent }))
    const enabled = normalize(await read($, options)).fableFallback !== 'off'
    if (enabled && e.error === 'rate_limit' && !e.agent_id && familyOf(lastMainModel) === 'fable' && !fableOut) {
      const capped = spent.some(r => r.percentUsed >= 100)
      const repeat = lastFableLimitAt !== null && now - lastFableLimitAt <= FABLE_REPEAT_WINDOW_MS
      lastFableLimitAt = now
      let until: number | null = null
      if (capped || looksLikeUsageCap(details)) {
        const resets = spent.filter(r => r.percentUsed >= 100 && r.resetsAt).map(r => Date.parse(r.resetsAt as string)).filter(t => Number.isFinite(t) && t > now)
        until = resets.length > 0 ? Math.min(...resets) : now + FABLE_OUT_DEFAULT_MS
      } else if (repeat) until = now + FABLE_REPEAT_HOLD_MS
      if (until !== null) {
        const at = new Date(until)
        const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
        fableOut = { until, clock, note: '' }
        lastFableLimitAt = null
        await update($, warnings, list => [...list.filter(w => !w.startsWith(FABLE_OUT_WARNING)), `${FABLE_OUT_WARNING}${clock}`])
        await emit($, fallbackLine(now, { from: MODEL_IDS.fable, to: MODEL_IDS.opus, until, reason: 'rate_limit' }))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, request, next) {
    // Fable out of usage: after the reset the state clears; until then a Fable request goes out as Opus, effort unchanged.
    // This beats the Fable lock and claude mode, for the main thread and for sub-agents alike.
    if (fableOut && (await $.clock.now()) >= fableOut.until) {
      fableOut = null
      await update($, warnings, list => list.filter(w => !w.startsWith(FABLE_OUT_WARNING)))
    }
    const swapped = fableOut !== null && familyOf(request.model) === 'fable'
    const e = swapped ? { ...request, model: MODEL_IDS.opus } : request
    const sub = e.agentId ? subagents.get(e.agentId) : undefined
    const meta = e.agentId ? agentMeta.get(e.agentId) : undefined
    if (meta) meta.steps += 1
    // Options saved by an older version lack the guard fields, or carry the old fableLock flag: normalize fills them in
    const opts = normalize(await read($, options))
    // A fallback that overrides a pin or the Fable lock says so in the band
    if (swapped && fableOut && !e.agentId) {
      const note = turnPin?.model === 'fable' || opts.pin === 'fable' ? ' · pin paused' : opts.locks.includes('fable') ? ' · lock paused' : ''
      if (note !== fableOut.note) {
        fableOut.note = note
        const text = `${FABLE_OUT_WARNING}${fableOut.clock}${note}`
        await update($, warnings, list => [...list.filter(w => !w.startsWith(FABLE_OUT_WARNING)), text])
      }
    }
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
    if (!e.agentId) {
      lastRequestAt = await $.clock.now()
      lastStepAt = lastRequestAt
      // Auto-arm: a real main-thread request opens a window when none is open and /cr-warm off did not end auto-arm.
      // An auto window rolls: each request pushes the deadline to now + WARM_DEFAULT_MS (capped at now + WARM_MAX_MS), never back.
      // A manual window keeps its own deadline, and pings never get here, so they extend nothing.
      const at = lastRequestAt
      const until = normalize(await read($, options)).warmUntil
      if (until <= at) {
        if (WARM_AUTO && !autoOff) {
          const armed = at + WARM_DEFAULT_MS
          autoUntil = armed
          lastHeartbeatAt = at
          await update($, options, o => ({ ...o, warmUntil: armed }))
          await emit($, warmEvent(at, taskNo, 'armed', { via: 'auto', until: armed, minutes: Math.round(WARM_DEFAULT_MS / 60_000) }))
        }
      } else if (autoUntil > 0 && until === autoUntil) {
        const rolled = Math.min(Math.max(until, at + WARM_DEFAULT_MS), at + WARM_MAX_MS)
        if (rolled > until) {
          autoUntil = rolled
          await update($, options, o => ({ ...o, warmUntil: rolled }))
        }
      }
    }
    // Pass-through: the request keeps the model and effort it arrived with, and the band says why.
    //  - orchestrator mode, or a model lock (Fable by default), or an id the router does not know: a main-thread
    //    session is left alone, unless a pin or an "@model" prefix says otherwise.
    //  - a subagent keeps each part someone else set: its model when the Agent call, its file or an environment
    //    variable set it, its effort likewise. The router only fills in the part nobody set. A subagent on a locked
    //    model keeps both.
    const family = familyOf(e.model)
    const locked = family !== null && opts.locks.includes(family)
    const orchestrating = opts.orchestrator !== 'off'
    const lockMain = !e.agentId && (orchestrating || family === null || locked || swapped) && !turnPin && !opts.pin && e.model !== routedLocked
    const heldModel = Boolean(e.agentId) && (locked || (sub !== undefined && !isRouted(sub.who.model)))
    const heldEffort = Boolean(e.agentId) && (locked || (sub !== undefined && !isRouted(sub.who.effort)))
    // Claude Code mode: nothing is changed, pins and locks included; the turn is still recorded
    const claudeMode = opts.mode === 'claude'
    if (claudeMode || lockMain || (heldModel && heldEffort)) {
      const level = toLevel(e.effort)
      const shown: Model = family ?? 'fable'
      if (!e.agentId) lastMainModel = e.model
      const passed = yield* next(e)
      const why = claudeMode ? 'claude code mode · routing off' : e.agentId
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
    // Fable is out: nothing the router or a pin picks may go to Fable
    if (fableOut && pick.model === 'fable') pick = { ...pick, model: 'opus' }
    const kept = familyOf(e.model) === pick.model
    const sentId = heldModel ? e.model : idFor(pick.model, e.model)
    if (!e.agentId) {
      lastMainModel = sentId
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
      const denied = managerVerdict(e.tool, e as unknown as Record<string, unknown>, { home, cwd: sessionCwd })
      if (denied !== null) {
        const task = turnId
        await update($, tasks, list => list.map(t => (t.id === task ? { ...t, blocks: (t.blocks ?? 0) + 1 } : t)))
        const command = (e as unknown as Record<string, unknown>).command
        await emit($, blockLine(await $.clock.now(), taskNo, { ...denied, ...(typeof command === 'string' ? { command } : {}) }))
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
    // A Workflow call is always allowed here: it is logged by its meta name (when the input has one) and remembered, so its agents carry it
    if (e.tool === 'Workflow' && !e.agentId) {
      const meta = raw.meta as { name?: unknown } | undefined
      const named = typeof meta?.name === 'string' ? meta.name : typeof raw.name === 'string' ? raw.name : ''
      currentWorkflow = named
      await emit($, workflowLine(await $.clock.now(), taskNo, named || null))
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
      const failed = rules === null ? null : await injectRules($, rules)
      if (failed !== null) await rulesFailed($, failed)
    }
    return done
  }).catch(($, e, next) => next(e))

  // Runs when a skill's text is expanded for Claude: it has loaded and is in use
  // A ClaudeRouter command stub (commands/cr-*.md) is not a skill in use: it runs its command and the model gets the reply
  on('skill.prompt', async ($, e, next) => {
    const done = await next(e)
    const replaced = typeof done.text === 'string' ? await runMarker($, done.text) : null
    if (replaced !== null) return { ...done, text: replaced }
    await update($, skills, list => bumpSkill(list, e.skill))
    return done
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
    // The effort the Agent call rode in on, or the one the spawn itself carries
    const spawnEffort = (e as { effort?: unknown }).effort
    const callEffort = callEfforts.get(e.tool_use_id) ?? (typeof spawnEffort === 'string' ? spawnEffort : undefined)
    callEfforts.delete(e.tool_use_id)
    // Only a Workflow's own agents count toward the ultracode warning, not a plain Agent call made after a Workflow ran
    const isWorkflowAgent = e.subagentType === 'workflow-subagent'
    let who = whoSets({
      callModel: e.model,
      callEffort,
      front,
      // A Workflow's agent has no agent file to read: without this it counts as "blind" (by=default) and is never routed
      builtin: isBuiltin(e.subagentType) || e.subagentType === 'workflow-subagent',
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
    // A Workflow's agents arrive with no parentModel: that is "unknown", not a locked parent, so they are routed (Opus/Fable down to Sonnet)
    const parentUnknown = e.parentModel === undefined || e.parentModel === null || e.parentModel === ''
    const inherit = isRouted(who.model) && parentLocked && opts.orchestrator === 'off' && !(e.subagentType === 'workflow-subagent' && parentUnknown)
    if (inherit) who = { model: 'default', effort: isRouted(who.effort) ? 'default' : who.effort }
    // Claude Code mode: the Agent call goes out exactly as it came
    const sendModel = opts.mode === 'claude' ? e.model : isRouted(who.model) ? spawnModel : inherit ? e.parentModel : e.model
    const result = await next(sendModel === e.model ? e : { ...e, model: sendModel })
    if (result.deny) return result

    // Orchestrator on: a general-purpose agent has no roster role, the band says so
    if (opts.orchestrator === 'on' && e.subagentType === 'general-purpose') {
      await update($, warnings, list => (list.includes(GENERAL_WARNING) ? list : [...list, GENERAL_WARNING]))
    }
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
    await update($, tasks, list => {
      const attached = attachAgent(list, turnId, agent)
      return isWorkflowAgent ? patchTask(attached, turnId, { workflowAgents: (attached.find(t => t.id === turnId)?.workflowAgents ?? 0) + 1 }) : attached
    })
    if (result.agentId) {
      const named = skillsNamed(e.prompt)
      agentMeta.set(result.agentId, { n: taskNo, type: e.subagentType, model: result.model, named, maxTurns: Number(front?.maxTurns) > 0 ? Number(front?.maxTurns) : null, steps: 0 })
      await emit($, launchLine(await $.clock.now(), taskNo, { id: result.agentId, type: e.subagentType, model: result.model, effort: agent.effort, by: who, brief: e.prompt, skills: named, wf: e.subagentType === 'workflow-subagent' ? (currentWorkflow || 'workflow') : null }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Runs when a turn ends, for the main conversation and for each subagent
  on('turn.complete', async ($, e, next) => {
    // First thing, so an error in the log or state work below (or an aborted turn) cannot leave busy set
    if (!e.agentId) busy = false
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
        if (/(^|:)verifier$/i.test(meta.type)) {
          const counted = meta.handback ?? verdictOf(e.answer)
          // Cut at its turn cap with no PASS/FAIL/NOT CHECKED line in the report: 'cut', not 'not checked'
          const v = how === 'maxTurns' && counted.pass + counted.fail + counted.unchecked === 0 ? { ...counted, verdict: 'cut' as const } : counted
          await emit($, verdictLine(at, meta.n, { id: agentId, ...v }))
        }
      } else if (!agentId) {
        // A turn with no tokens and no model (a keep-warm fork, an aborted turn) is not a record
        const empty = !model && split.tokensIn + split.tokensCached + split.tokensOut + split.tokensWrite === 0
        if (!empty) await emit($, mainLine(at, taskNo, { model: model || '—', effort: (await read($, route))?.effort ?? null, in: split.tokensIn, cached: split.tokensCached, out: split.tokensOut, cost, sec: seconds }))
        // The report is rewritten after each main turn, so a session that never sees session.end (a spare one) still has it
        if (logPath) await writeMd($, at)
      }
    }

    if (agentId) {
      await update($, tasks, list => patchAgent(list, agentId, { status, seconds, tokens, ...split }))
    } else {
      busy = false // also when isAborted
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
    const now = await $.clock.now()
    if (lastProbeAt === null || now - lastProbeAt >= PROBE_EVERY_MS) {
      lastProbeAt = now
      const limits = (e as { rateLimits?: unknown }).rateLimits
      await emit($, probeLine(now, { source: 'measure', code: null, detailsLen: null, who: 'none', family: familyOf(lastMainModel), limits: Array.isArray(limits) ? limits : [] }))
    }
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
