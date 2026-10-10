import type { Options } from '../types'

export const DEFAULT_OPTIONS: Options = { engine: 'rules', warmUntil: 0 }
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
  '/clauderouter status          show the current options',
].join('\n')

// "90m", "2h", "45" (minutes) -> ms, or null
export function parseWindow(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mh]?)$/i.exec(s.trim())
  if (!m) return null
  const ms = Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 3_600_000 : 60_000)
  return ms > 0 ? Math.min(ms, WARM_MAX_MS) : null
}

export function describe(o: Options, now: number): string {
  const warm = o.warmUntil > now ? `on, ${Math.round((o.warmUntil - now) / 60_000)} min left` : 'off'
  return `engine: ${o.engine} · keep-warm: ${warm}`
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
    case 'status':
      return { next: null, text: describe(o, now) }
    default:
      return { next: null, text: USAGE }
  }
}
