import type { Effort, Model } from '../types'
import type { Creative, RoutePick } from './route'

// Cost guards: pure limits applied on top of the router's pick, on every model request.
// The router decides what a prompt *looks like*; the guard decides what the turn may *cost*.

// The levels the router picks, caps and pins. 'max' exists only when an agent file or an Agent call sets it.
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh']
const ORDER: Effort[] = [...EFFORTS, 'max']
const MODELS: Model[] = ['haiku', 'sonnet', 'opus', 'fable']
const rankE = (e: Effort) => ORDER.indexOf(e)

// An effort the engine reports (a level, or a number on some builds) as one of the five levels, else null
export const toLevel = (v: unknown): Effort | null => ORDER.find(l => l === v) ?? null
const rankM = (m: Model) => MODELS.indexOf(m)

export const capEffort = (e: Effort, max: Effort): Effort => (rankE(e) > rankE(max) ? max : e)
const capModel = (m: Model, max: Model): Model => (rankM(m) > rankM(max) ? max : m)

// Effort when a model is pinned without one
export const DEFAULT_EFFORT: Record<Model, Effort> = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'high' }

// Opus may plan: it keeps the first requests of a turn, then the turn moves to Sonnet
export const OPUS_STEPS = 2
// A prompt longer than this is a spec, not a question: Opus on it never runs above medium
export const LONG_PROMPT = 1200
// This many tool calls in one turn = it is executing, not planning
export const EXEC_TOOLS = 6
// Haiku 5.5 bills a prompt above 100k tokens at five times its base rates (platform.claude.com pricing, checked
// 2026-11-12), and moving the main thread to it re-reads the whole context uncached. Past this size a light request
// stays on Sonnet, whose cache is usually warm.
export const HAIKU_CTX = 100_000
const WRITES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export type Pin = { model: Model; effort: Effort | null }

export type GuardInput = {
  pick: RoutePick
  // The user's explicit choice (a turn directive or /cr-pin): wins over every limit
  pin: Pin | null
  maxEffort: Effort
  // USD one turn may spend before the guard downgrades it; 0 = off
  budget: number
  // Context tokens above which the guard downgrades; 0 = off
  ctxCap: number
  isSub: boolean
  isPlan: boolean
  // Index of this request within its turn
  step: number
  textLen: number
  turnTools: readonly string[]
  contextTokens: number | null
  // USD spent since the turn started
  turnCost: number | null
  // Creative work (flagship, craft, bulk): the turn keeps a strong model or, where a limit takes the model down,
  // a high effort. Its effort ceiling is creativeCap, not maxEffort.
  creative?: Creative | null
  // Highest effort creative work may run at; xhigh when unset
  creativeCap?: Effort
}

export type Guarded = { model: Model; effort: Effort; limits: string[] }

export function guard(i: GuardInput): Guarded {
  if (i.pin) {
    const effort = i.pin.effort ?? (i.pin.model === i.pick.model ? i.pick.effort : DEFAULT_EFFORT[i.pin.model])
    return { model: i.pin.model, effort, limits: ['pinned'] }
  }
  let { model, effort } = i.pick
  const limits: string[] = []
  const creative = i.creative ?? null
  // The effort a creative turn keeps where a limit takes it down; any other turn keeps medium
  const floor: Effort = creative ? 'high' : 'medium'

  const ceiling = creative ? (i.creativeCap ?? 'xhigh') : i.maxEffort
  if (rankE(effort) > rankE(ceiling)) {
    effort = ceiling
    limits.push(`effort≤${ceiling}`)
  }

  // Plan with Opus, execute with Sonnet. Fable only gets here when the router picked it for flagship creative work.
  if (model === 'opus' || model === 'fable') {
    const executing = i.turnTools.some(t => WRITES.includes(t)) || i.turnTools.length >= EXEC_TOOLS
    if (i.isSub && !i.isPlan) {
      model = 'sonnet'
      effort = capEffort(effort, floor)
      limits.push('subagent→sonnet')
    } else if (creative) {
      // Creative work stays on its model for the whole turn, writing included: no plan/execute split, no long-prompt cap
      limits.push(`${creative}: strong`)
    } else if (!i.isSub && (i.step >= OPUS_STEPS || executing)) {
      model = 'sonnet'
      effort = capEffort(effort, 'medium')
      limits.push('opus plans only')
    } else if (i.textLen > LONG_PROMPT) {
      effort = capEffort(effort, 'medium')
      limits.push('long prompt')
    }
  }

  // A subagent is never above medium (high for creative work) unless it plans
  if (i.isSub && !i.isPlan) effort = capEffort(effort, floor)

  // Main thread only: a subagent has a small context of its own, and contextTokens is the session's
  if (model === 'haiku' && !i.isSub && i.contextTokens !== null && i.contextTokens > HAIKU_CTX) {
    model = 'sonnet'
    limits.push('haiku>100k')
  }

  if (i.ctxCap > 0 && i.contextTokens !== null && i.contextTokens > i.ctxCap) {
    model = capModel(model, 'sonnet')
    // Creative work keeps a high effort even when the model is taken down
    effort = capEffort(effort, creative ? 'high' : i.contextTokens > i.ctxCap * 1.5 ? 'low' : 'medium')
    limits.push(`ctx ${Math.round(i.contextTokens / 1000)}k`)
  }

  if (i.budget > 0 && i.turnCost !== null && i.turnCost > i.budget) {
    model = capModel(model, 'sonnet')
    effort = capEffort(effort, creative ? 'high' : i.turnCost > i.budget * 2 ? 'low' : 'medium')
    limits.push(`turn $${i.turnCost.toFixed(2)}>$${i.budget}`)
  }
  return { model, effort, limits }
}

// "@sonnet", "@opus:high", "@haiku:med" at the very start of a prompt pins that turn
const DIRECTIVE = /^\s*@(haiku|sonnet|opus|fable)(?::(low|med|medium|high|xhigh))?(?=\s|$)/i

export function toEffort(s: string): Effort | null {
  const v = s.toLowerCase() === 'med' ? 'medium' : s.toLowerCase()
  return EFFORTS.find(e => e === v) ?? null
}

export function directiveOf(text: string): Pin | null {
  const m = DIRECTIVE.exec(text)
  if (!m) return null
  return { model: m[1]!.toLowerCase() as Model, effort: m[2] ? toEffort(m[2]) : null }
}

// ── Manager guard (orchestrator on) ─────────────────────────────────────────────────────────────────────────
// With the orchestrator on, the main thread manages: it briefs, waits, reads reports and decides. It does not read
// code, edit files or run commands. Sub-agents are never guarded, and neither is anything when the mode is off or
// "hands on". This is a pure check on one tool call; the hook applies it to the main thread only.

const BACKSLASH = String.fromCharCode(92)
const slashes = (p: string) => p.split(BACKSLASH).join('/')
// What the manager may touch, as names inside the session's project folder (cwd) and inside ~/.claude.
// Read: the project's map, handoff and rules files, and plans/. Write: map, handoff and rules, plans/ and old-handoff/.
const READ_FILES = ['map.md', 'handoff.md', 'claude.md']
const READ_DIRS = ['plans']
const WRITE_FILES = ['handoff.md', 'map.md', 'claude.md']
const WRITE_DIRS = ['plans', 'old-handoff']

// The session's folder and the user's home: the project files count only inside the first, ~/.claude only under the second
export type ManagerCtx = { home: string | undefined; cwd?: string | undefined }

// Segments after a root: a drive ("c:/"), a UNC share ("//") or a POSIX root ("/")
const ROOT = /^(?:[a-z]:\/|\/\/|\/)/i

// One canonical form for a path, used before EVERY clause: separators unified, "~" expanded to home, a relative path
// placed under the project folder, "." and ".." segments collapsed (a ".." never climbs above the root), case folded.
// null when the path cannot be placed (relative with no folder to place it in, drive-relative "c:x", no home for "~").
function canon(p: string, home?: string, cwd?: string): string | null {
  let n = slashes(p).trim()
  if (n === '~' || n.startsWith('~/')) {
    const h = home ? canon(home) : null
    if (h === null) return null
    n = `${h}${n.slice(1)}`
  } else if (!ROOT.test(n)) {
    const c = cwd ? canon(cwd) : null
    if (c === null) return null
    n = `${c}/${n}`
  }
  const m = ROOT.exec(n)
  if (!m) return null
  const out: string[] = []
  for (const part of n.slice(m[0].length).split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return m[0].toLowerCase() + out.join('/').toLowerCase()
}

const under = (n: string, dir: string) => n === dir || n.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

// The user's own folders: ~/.claude/orchestrator.md, ~/.claude/routing/ and ~/.claude/agents/ (read and write).
// Every other path under ~/.claude (settings.json, plans/, ...) is refused, and the project clauses never apply there.
// Root cause of the refused Edit on ~/.claude/orchestrator.md: only mayRead consulted this check; mayWrite never did.
function claudeHome(n: string, home: string | undefined): 'yes' | 'no' | 'outside' {
  const h = home ? canon(home) : null
  if (h === null) return 'outside'
  const claude = `${h.replace(/\/$/, '')}/.claude`
  if (!under(n, claude)) return 'outside'
  return n === `${claude}/orchestrator.md` || under(n, `${claude}/routing`) || under(n, `${claude}/agents`) ? 'yes' : 'no'
}

// The project folder as the guard knows it, or null when none is known (or it is a drive root, which is no project)
function projectOf(ctx: ManagerCtx): string | null {
  const c = ctx.cwd ? canon(ctx.cwd) : null
  return c === null || ROOT.exec(c)?.[0] === c ? null : c
}

// A project-relative path the project clauses may serve: no ".claude" segment (that folder goes only through claudeHome)
// and no segment with "~" (an 8.3 short name such as CLAUDE~1 or STUDI~1 can alias a folder the long form would refuse)
const plainRel = (rel: string) => !rel.split('/').some(s => s === '.claude' || s.includes('~'))

function allowed(p: string, ctx: ManagerCtx, files: readonly string[], dirs: readonly string[], dirItself: boolean): boolean {
  if (p.trim() === '') return false
  const n = canon(p, ctx.home, ctx.cwd)
  if (n === null) return false
  const home = claudeHome(n, ctx.home)
  if (home !== 'outside') return home === 'yes'
  const project = projectOf(ctx)
  if (project === null || !n.startsWith(`${project}/`)) return false
  const rel = n.slice(project.length + 1)
  if (!plainRel(rel)) return false
  if (files.includes(rel.split('/').pop() ?? '')) return true
  return dirs.some(d => rel.startsWith(`${d}/`) || (dirItself && rel === d))
}

const mayRead = (p: string, ctx: ManagerCtx) => allowed(p, ctx, READ_FILES, READ_DIRS, true)
const mayWrite = (p: string, ctx: ManagerCtx) => allowed(p, ctx, WRITE_FILES, WRITE_DIRS, false)

// A search with no folder of its own runs in the session's folder; with one, it must be inside the project
function searchesProject(dir: string, ctx: ManagerCtx): boolean {
  const project = projectOf(ctx)
  const n = canon(dir === '' ? (ctx.cwd ?? '') : dir, ctx.home, ctx.cwd)
  return project !== null && n !== null && under(n, project) && claudeHome(n, ctx.home) === 'outside' && plainRel(n.slice(project.length + 1))
}
// A glob that stays relative and never climbs: "MAP.md", "**/handoff.md", "plans/**". Anything that could spell a climb
// or hide one (".." anywhere, braces, character classes, "%" escapes, "~") is refused.
const relativeGlob = (g: string): boolean => {
  const s = slashes(g).trim()
  return s !== '' && !ROOT.test(s) && !/\.\.|[{[%~]/.test(s)
}

const GUIDE = 'reading → scout, change → coder, design or contract → architect, design and copy → art-copy, tests → test-runner, judging → verifier'

// The text the model reads when a call is refused: what is blocked, the agent to use, and the way out
export type Verdict = { message: string; tool: string; target: string; agent: string }
function say(tool: string, target: string, agent: string): Verdict {
  const message = `Orchestrator mode: the main session manages and does not do the work, so ${tool}${target ? ` on ${target}` : ''} is blocked. Delegate it: use the Agent tool with subagent_type "${agent}" (or, if the person opted into ultracode, a Workflow) and a self-contained brief (exact files, definition of done, limits, report cap). Which agent for what: ${GUIDE}. If a sub-agent report is unclear, ask the same agent a follow-up with SendMessage; do not open the files yourself. (The person can lift this with /cr-orchestrator off, or /cr-orchestrator hands on for an emergency.)`
  return { message, tool, target, agent }
}

// null = allowed. Everything not named here (Agent, SendMessage, the task tools, web and MCP tools) is allowed:
// the guard is about files and the shell. ctx.cwd is the session's project folder: the project files (MAP.md, HANDOFF.md,
// CLAUDE.md, plans/, old-handoff/) are allowed only inside it.
export const managerBlock = (tool: string, input: Record<string, unknown>, ctx: ManagerCtx): string | null => managerVerdict(tool, input, ctx)?.message ?? null

// The same check with what the log needs: the tool, the target path (none for Bash) and the agent the refusal names
export function managerVerdict(tool: string, input: Record<string, unknown>, ctx: ManagerCtx): Verdict | null {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Read': {
      const p = str('file_path')
      return mayRead(p, ctx) ? null : say('Read', p, 'scout')
    }
    case 'Glob':
    case 'Grep': {
      const dir = str('path')
      // A search is allowed inside an allowed folder or file, or, inside the project, when its glob names an allowed file
      // itself or stays under plans/. The glob must be relative and never climb ("..").
      const pattern = tool === 'Glob' ? str('pattern') : str('glob')
      const here = relativeGlob(pattern) && searchesProject(dir, ctx)
      const g = slashes(pattern).trim().toLowerCase()
      const named = here && READ_FILES.includes(g.split('/').pop() ?? '')
      const inPlans = here && /^(?:\.\/)?plans\//.test(g)
      return (dir !== '' && mayRead(dir, ctx)) || named || inPlans ? null : say(tool, dir || str('pattern') || str('glob'), 'scout')
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = str('file_path')
      return mayWrite(p, ctx) ? null : say(tool, p, 'coder')
    }
    case 'NotebookEdit':
      return say(tool, str('notebook_path'), 'coder')
    case 'Bash':
      return say('Bash', '', 'test-runner')
    default:
      return null
  }
}
