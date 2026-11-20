import type { Effort, Model, Options } from '../types'
import { EFFORTS, toEffort } from './guard'

export const DEFAULT_OPTIONS: Options = {
  engine: 'rules',
  warmUntil: 0,
  pin: null,
  pinEffort: null,
  // xhigh/max are never picked automatically
  maxEffort: 'high',
  budget: 3,
  ctxCap: 150_000,
  // A session on a locked model is left alone: no rerouting, no caps. Fable is locked by default.
  locks: ['fable'],
  band: 'full',
  // Flagship creative work goes to Fable at high by default; /cr-creative opus sends it to Opus at xhigh instead
  creative: 'fable',
  creativeCap: 'xhigh',
  // On by default: the session is the orchestrator (see Options.orchestrator); session.start loads the rules and falls
  // back to off when ~/.claude/orchestrator.md is missing. /cr-orchestrator off: the router behaves as it always did.
  orchestrator: 'on',
  rules: null,
  // router: the router picks model and effort. claude: Claude Code mode, pass-through, nothing is changed.
  mode: 'router',
  // advise: detect "ultracode" in a prompt, route and log Workflow agents, warn past ultraMax. The mod never turns ultracode on.
  ultracode: 'advise',
  ultraMax: 5,
  fableFallback: 'on',
}
export const ALL_MODELS: Model[] = ['haiku', 'sonnet', 'opus', 'fable']
const isModel = (s: string): s is Model => (ALL_MODELS as string[]).includes(s)

// Options saved by an older version: fill the guard fields, and turn the old fableLock flag into locks
export function normalize(saved: Partial<Options> & { fableLock?: boolean }): Options {
  const { fableLock, ...rest } = saved
  const locks = rest.locks ?? (fableLock === false ? [] : DEFAULT_OPTIONS.locks)
  return { ...DEFAULT_OPTIONS, ...rest, locks }
}
// A ping every 50 minutes keeps a one-hour prompt cache read instead of re-written
export const WARM_EVERY_MS = 50 * 60 * 1000
const WARM_DEFAULT_MS = 2 * 60 * 60 * 1000
const WARM_MAX_MS = 8 * 60 * 60 * 1000

export const USAGE = [
  '/cr                 open the pane, and bring back a closed band',
  '/cr-engine jev      let Jev pick the model tier (needs TYPESAFE_API_KEY)',
  '/cr-engine rules    use the local keyword rules (default)',
  '/cr-warm [2h]       keep the prompt cache warm for 2h (max 8h)',
  '/cr-warm off        stop keeping it warm (/cr-kw is the short form)',
  '/cr-pin sonnet [medium]  force a model (and effort) from the next request, even mid-turn',
  '/cr-pin auto        let the router decide again',
  '/cr-pin fable [high]  force Fable (also "@fable ..." for one prompt)',
  '/cr-lock opus       leave a session on that model alone: no rerouting, no caps (fable is locked by default)',
  '/cr-unlock opus     route that model like the others again; "/cr-lock all" / "/cr-lock none" for every model',
  '/cr-cap high        highest effort the router may pick by itself (default high)',
  '/cr-budget 3        USD one turn may spend before it is downgraded (off = no limit)',
  '/cr-ctx 150k        context size above which requests are downgraded (off = no limit)',
  '/cr-band route      band above the prompt: task bar and model route only (full = every row, off = closed)',
  '/cr-creative opus   flagship creative work (identity, naming, taglines, art direction) on Opus xhigh',
  '/cr-creative fable  flagship creative work on Fable high (default; uses your weekly Fable allowance)',
  '/cr-creative off    route creative prompts like any other',
  '/cr-creative cap high  highest effort creative work may run at (default xhigh)',
  '/cr-orchestrator on     (default) manager only: the session delegates, its file and shell tools are blocked, ~/.claude/orchestrator.md is loaded (/cr-orch is the short form)',
  '/cr-orchestrator hands on   emergency: the block is lifted, the rules stay loaded',
  '/cr-orchestrator off    back to routing the main model, no block',
  '/cr-mode claude     Claude Code mode: routing off, Claude Code keeps its own model and effort (tracking, logs and costs go on)',
  '/cr-mode router     routing on again (default)',
  '/cr-ultracode advise    detect ultracode, route and log Workflow agents, warn when a task launches too many (default; the mod never turns it on)',
  '/cr-ultracode off       no ultracode chip or warning',
  '/cr-ultracode max=5     Workflow agents one task may launch before the band warns',
  '/cr-fable reset     Fable is back now: clears the "Fable out of usage" fallback',
  '/cr-fable off       never fall back to Opus when Fable looks out of usage (on = default)',
  '/cr-status          show the current options',
  'Prompt prefix: "@sonnet:med ..." pins that one turn.',
].join('\n')

// One slash command per option: /cr-warm 2h runs applyArgs('warm 2h'). The bare /cr opens the pane.
export const OPTION_COMMANDS = ['engine', 'warm', 'pin', 'lock', 'unlock', 'cap', 'budget', 'ctx', 'band', 'creative', 'orchestrator', 'mode', 'ultracode', 'fable', 'status'] as const
// Short names: /cr-kw is /cr-warm, /cr-orch is /cr-orchestrator
export const OPTION_ALIASES: Record<string, (typeof OPTION_COMMANDS)[number]> = { kw: 'warm', orch: 'orchestrator' }

// "90m", "2h", "45" (minutes) -> ms, or null
export function parseWindow(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mh]?)$/i.exec(s.trim())
  if (!m) return null
  const ms = Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 3_600_000 : 60_000)
  return ms > 0 ? Math.min(ms, WARM_MAX_MS) : null
}

// "3", "$3", "off" -> USD / 0, or null
export function parseBudget(s: string): number | null {
  if (s.trim().toLowerCase() === 'off') return 0
  const n = Number(s.trim().replace(/^\$/, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

// "150k", "200000", "off" -> tokens / 0, or null
export function parseTokens(s: string): number | null {
  if (s.trim().toLowerCase() === 'off') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(k?)$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1]) * (m[2] ? 1000 : 1)
  return n > 0 ? Math.round(n) : null
}

// The orchestrator mode as /cr-status says it
export const modeText = (o: Options): string =>
  `${o.orchestrator === 'on' ? 'on (manager only)' : o.orchestrator === 'hands' ? 'hands on (guard off)' : 'off'} · rules ${o.rules === null ? 'not loaded' : `loaded (${sizeText(o.rules)})`}`
export const sizeText = (bytes: number): string => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`)

export function describe(o: Options, now: number): string {
  const warm = o.warmUntil > now ? `on, ${Math.round((o.warmUntil - now) / 60_000)} min left` : 'off'
  const pin = o.pin ? `${o.pin}${o.pinEffort ? `/${o.pinEffort}` : ''}` : 'auto'
  const budget = o.budget > 0 ? `$${o.budget}/turn` : 'off'
  const ctx = o.ctxCap > 0 ? `${Math.round(o.ctxCap / 1000)}k` : 'off'
  return `engine: ${o.engine} · model: ${pin} · locked: ${o.locks.length > 0 ? o.locks.join(', ') : 'none'} · max effort: ${o.maxEffort} · creative: ${o.creative}${o.creative === 'off' ? '' : ` (cap ${o.creativeCap})`} · budget: ${budget} · ctx cap: ${ctx} · mode: ${o.mode === 'claude' ? 'claude code (routing off)' : 'router'} · ultracode: ${o.ultracode}${o.ultracode === 'advise' ? ` (warn above ${o.ultraMax} workflow agents)` : ''} · fable fallback: ${o.fableFallback} · orchestrator: ${modeText(o)} · keep-warm: ${warm}`
}

// Applies one /cr argument string. next is null when the args are not an option change.
export function applyArgs(args: string, o: Options, now: number): { next: Options | null; text: string } {
  const [cmd = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd.toLowerCase()) {
    case 'engine':
      if (arg !== 'jev' && arg !== 'rules') return { next: null, text: `engine takes jev or rules\n${USAGE}` }
      return { next: { ...o, engine: arg }, text: `engine: ${arg}` }
    case 'warm': {
      if (arg === 'off') return { next: { ...o, warmUntil: 0 }, text: 'keep-warm: off' }
      const ms = arg ? parseWindow(arg) : WARM_DEFAULT_MS
      if (ms === null) return { next: null, text: `warm takes a duration like 90m or 2h, or off\n${USAGE}` }
      return { next: { ...o, warmUntil: now + ms }, text: `keep-warm: on for ${Math.round(ms / 60_000)} min, a ping every 50 min while idle` }
    }
    case 'pin': {
      const [m = '', e = ''] = arg.split(/\s+/)
      if (m === 'auto' || m === 'off') return { next: { ...o, pin: null, pinEffort: null }, text: 'model: auto' }
      if (m !== 'haiku' && m !== 'sonnet' && m !== 'opus' && m !== 'fable') return { next: null, text: `pin takes haiku, sonnet, opus, fable or auto\n${USAGE}` }
      const effort: Effort | null = e ? toEffort(e) : null
      if (e && !effort) return { next: null, text: `effort takes ${EFFORTS.join(', ')}\n${USAGE}` }
      const pin: Model = m
      return { next: { ...o, pin, pinEffort: effort }, text: `model pinned: ${pin}${effort ? `/${effort}` : ''}` }
    }
    case 'lock':
    case 'unlock': {
      const on = cmd.toLowerCase() === 'lock'
      const m = arg.trim().toLowerCase()
      if (on && m === 'all') return { next: { ...o, locks: [...ALL_MODELS] }, text: 'locked: every model is left alone' }
      if ((on && m === 'none') || (!on && m === 'all')) return { next: { ...o, locks: [] }, text: 'locked: none, every model is routed' }
      if (!isModel(m)) return { next: null, text: `${cmd} takes ${ALL_MODELS.join(', ')}${on ? ', all or none' : ' or all'}\n${USAGE}` }
      const locks = on ? [...new Set([...o.locks, m])] : o.locks.filter(x => x !== m)
      return { next: { ...o, locks }, text: `${m} ${on ? 'locked: a session on it is left alone' : 'unlocked: routed like the others'} · locked: ${locks.length > 0 ? locks.join(', ') : 'none'}` }
    }
    // Kept from 0.4.1: "fable lock" and "fable auto"
    case 'fable': {
      const a = arg.trim().toLowerCase()
      if (a === 'reset') return { next: o, text: 'fable fallback cleared: Fable requests go to Fable again' }
      if (a === 'on' || a === 'off') return { next: { ...o, fableFallback: a }, text: a === 'on' ? 'fable fallback: on · Fable out of usage goes to Opus until the reset' : 'fable fallback: off · Fable is never swapped for Opus (a current fallback is cleared)' }
      if (arg !== 'lock' && arg !== 'auto') return { next: null, text: `fable takes reset, on, off, lock or auto\n${USAGE}` }
      return applyArgs(`${arg === 'lock' ? 'lock' : 'unlock'} fable`, o, now)
    }
    case 'cap': {
      const effort = toEffort(arg)
      if (!effort) return { next: null, text: `cap takes ${EFFORTS.join(', ')}\n${USAGE}` }
      return { next: { ...o, maxEffort: effort }, text: `max auto effort: ${effort}` }
    }
    case 'budget': {
      const usd = parseBudget(arg)
      if (usd === null) return { next: null, text: `budget takes a USD amount like 3, or off\n${USAGE}` }
      return { next: { ...o, budget: usd }, text: usd > 0 ? `turn budget: $${usd}` : 'turn budget: off' }
    }
    case 'ctx': {
      const tokens = parseTokens(arg)
      if (tokens === null) return { next: null, text: `ctx takes a size like 150k, or off\n${USAGE}` }
      return { next: { ...o, ctxCap: tokens }, text: tokens > 0 ? `context cap: ${Math.round(tokens / 1000)}k` : 'context cap: off' }
    }
    case 'band': {
      const mode = arg.trim().toLowerCase()
      if (mode !== 'full' && mode !== 'route' && mode !== 'off') return { next: null, text: `band takes full, route or off\n${USAGE}` }
      return { next: { ...o, band: mode }, text: `band: ${mode}` }
    }
    case 'creative': {
      const [a = '', b = ''] = arg.trim().toLowerCase().split(/\s+/)
      if (a === 'cap') {
        const effort = toEffort(b)
        if (!effort) return { next: null, text: `creative cap takes ${EFFORTS.join(', ')}\n${USAGE}` }
        return { next: { ...o, creativeCap: effort }, text: `creative effort ceiling: ${effort}` }
      }
      if (a !== 'opus' && a !== 'fable' && a !== 'off') return { next: null, text: `creative takes opus, fable, off or cap <effort>\n${USAGE}` }
      const said = a === 'off' ? 'creative: off, routed like any other prompt' : `creative: flagship work on ${a === 'fable' ? 'Fable high' : 'Opus xhigh'}, craft on Opus high, bulk on Sonnet high`
      return { next: { ...o, creative: a }, text: said }
    }
    case 'orchestrator': {
      const word = arg.trim().toLowerCase().replace(/\s+/g, ' ')
      const mode = word === 'hands' || word === 'hands on' ? 'hands' : word
      if (mode !== 'on' && mode !== 'off' && mode !== 'hands') return { next: null, text: `orchestrator takes on, hands on or off\n${USAGE}` }
      // "on" and "hands" are confirmed by the hooks once the rules file is found; this is the pure part
      const said = mode === 'off' ? 'orchestrator: off' : `orchestrator: ${mode === 'on' ? 'on · manager only' : 'hands on · guard off'}`
      return { next: { ...o, orchestrator: mode, ...(mode === 'off' ? { rules: null } : {}) }, text: said }
    }
    case 'mode': {
      const mode = arg.trim().toLowerCase()
      if (mode !== 'router' && mode !== 'claude') return { next: null, text: `mode takes router or claude\n${USAGE}` }
      return { next: { ...o, mode }, text: mode === 'claude' ? 'mode: claude code · routing off, Claude Code keeps its own model and effort' : 'mode: router · routing on' }
    }
    case 'ultracode': {
      const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
      let next: Options = o
      const said: string[] = []
      for (const w of words) {
        const m = /^max=(\d+)$/.exec(w)
        if (w === 'off' || w === 'advise') {
          next = { ...next, ultracode: w }
          said.push(w === 'off' ? 'ultracode: off' : 'ultracode: advise · detects, routes, logs and warns; only you turn ultracode on')
        } else if (m && Number(m[1]) > 0) {
          next = { ...next, ultraMax: Number(m[1]) }
          said.push(`warn above ${m[1]} workflow agents per task`)
        } else return { next: null, text: `ultracode takes off, advise or max=N\n${USAGE}` }
      }
      if (said.length === 0) return { next: null, text: `ultracode takes off, advise or max=N\n${USAGE}` }
      return { next, text: said.join(' · ') }
    }
    case 'status':
      return { next: null, text: describe(o, now) }
    default:
      return { next: null, text: USAGE }
  }
}
