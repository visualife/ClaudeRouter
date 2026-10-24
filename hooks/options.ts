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
}
// A ping every 50 minutes keeps a one-hour prompt cache read instead of re-written
export const WARM_EVERY_MS = 50 * 60 * 1000
const WARM_DEFAULT_MS = 2 * 60 * 60 * 1000
const WARM_MAX_MS = 6 * 60 * 60 * 1000

export const USAGE = [
  '/clauderouter                 open the pane',
  '/clauderouter engine jev      let Jev pick the model tier (needs TYPESAFE_API_KEY)',
  '/clauderouter engine rules    use the local keyword rules (default)',
  '/clauderouter warm [2h]       keep the prompt cache warm for 2h (max 6h)',
  '/clauderouter warm off        stop keeping it warm',
  '/clauderouter pin sonnet [medium]  force a model (and effort) from the next request, even mid-turn',
  '/clauderouter pin auto        let the router decide again',
  '/clauderouter cap high        highest effort the router may pick by itself (default high)',
  '/clauderouter budget 3        USD one turn may spend before it is downgraded (off = no limit)',
  '/clauderouter ctx 150k        context size above which requests are downgraded (off = no limit)',
  '/clauderouter status          show the current options',
  'Prompt prefix: "@sonnet:med ..." pins that one turn.',
].join('\n')

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

export function describe(o: Options, now: number): string {
  const warm = o.warmUntil > now ? `on, ${Math.round((o.warmUntil - now) / 60_000)} min left` : 'off'
  const pin = o.pin ? `${o.pin}${o.pinEffort ? `/${o.pinEffort}` : ''}` : 'auto'
  const budget = o.budget > 0 ? `$${o.budget}/turn` : 'off'
  const ctx = o.ctxCap > 0 ? `${Math.round(o.ctxCap / 1000)}k` : 'off'
  return `engine: ${o.engine} · model: ${pin} · max effort: ${o.maxEffort} · budget: ${budget} · ctx cap: ${ctx} · keep-warm: ${warm}`
}

// Applies one /clauderouter argument string. next is null when the args are not an option change.
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
      if (m !== 'haiku' && m !== 'sonnet' && m !== 'opus') return { next: null, text: `pin takes haiku, sonnet, opus or auto\n${USAGE}` }
      const effort: Effort | null = e ? toEffort(e) : null
      if (e && !effort) return { next: null, text: `effort takes ${EFFORTS.join(', ')}\n${USAGE}` }
      const pin: Model = m
      return { next: { ...o, pin, pinEffort: effort }, text: `model pinned: ${pin}${effort ? `/${effort}` : ''}` }
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
    case 'status':
      return { next: null, text: describe(o, now) }
    default:
      return { next: null, text: USAGE }
  }
}
