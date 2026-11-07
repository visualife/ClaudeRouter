import type { Agent, Effort, Model } from '../types'

// The mascot a subagent wears: Explore scouts, Plan plans, research reads, the rest build
export function roleOf(subagentType: string, text: string): Agent['role'] {
  if (/explore/i.test(subagentType)) return 'scout'
  if (/plan/i.test(subagentType)) return 'planner'
  if (/\b(research|investigat\w*|verify|trace|review|audit)\b/i.test(text)) return 'researcher'
  return 'builder'
}

// Local heuristics only: no model is called to decide. Counts keyword hits per tier,
// prompt length, the subagent's type and the tools this turn has used.
export type RouteInput = {
  text: string
  tools: readonly string[]
  subagentType?: string
  current?: Model | null
}

// ponytail: fixed constant; move to $.state config if tuning is wanted
export const HYSTERESIS = 0.08

export type RoutePick = { model: Model; effort: Effort; conf: number }

const HEAVY = /\b(plan|architect\w*|design|debug\w*|trace|root cause|refactor\w*|migrat\w*|security|race|deadlock|trade-?offs?|investigat\w*|why|performance|optimi[sz]e\w*|across|system)\b/gi
const MID = /\b(write|implement\w*|fix\w*|test\w*|fixtures?|review\w*|add|update|build)\b/gi
const LIGHT = /\b(list|read|show|rename|print|count|find|grep|format|typo|log|open|which|where|summari[sz]e)\b/gi
const DEEP = /\b(plan|architect\w*)\b/i
const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const SEARCH = ['Glob', 'Grep', 'Read']
// The tiers the router scores by itself. Fable is never picked automatically: the user chooses it.
export type Auto = 'haiku' | 'sonnet' | 'opus'
const FAMILIES: Auto[] = ['haiku', 'sonnet', 'opus']
const KNOWN: Model[] = [...FAMILIES, 'fable']
export const isAuto = (m: Model | null | undefined): m is Auto => m === 'haiku' || m === 'sonnet' || m === 'opus'

// Full ids for a model that cannot be derived from the running id: versions differ per family
export const MODEL_IDS: Record<Model, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

// The model family a full model id belongs to, or null when it names none
export function familyOf(id: string): Model | null {
  const lower = id.toLowerCase()
  return KNOWN.find(f => lower.includes(f)) ?? null
}

// The full model id for a family. The running id is kept when it already is that family. Between haiku, sonnet
// and opus the family word is swapped, so the version suffix is kept. Anything else (Fable, an unknown id) uses
// the known id: swapping a word in a Fable id would invent an id that does not exist.
export function idFor(family: Model, running: string): string {
  if (familyOf(running) === family) return running
  const swap = isAuto(family) && isAuto(familyOf(running))
  return swap ? running.replace(/haiku|sonnet|opus/, family) : MODEL_IDS[family]
}

const hits = (text: string, re: RegExp, cap: number) => Math.min(cap, (text.match(re) ?? []).length)

// Scores each tier and picks the highest; a tie, or no signal at all, stays on sonnet
export function pickRoute(input: RouteInput): RoutePick {
  const { text, tools } = input
  const heavy = hits(text, HEAVY, 3)
  const score = { haiku: hits(text, LIGHT, 2), sonnet: 0.5 + hits(text, MID, 2), opus: heavy }

  if (text.length > 400) score.opus += 1
  else if (text.length < 60 && heavy === 0) score.haiku += 1
  if (input.subagentType === 'Explore') score.haiku += 2
  if (input.subagentType === 'Plan') score.opus += 2
  if (heavy === 0 && tools.length > 0 && tools.every(t => SEARCH.includes(t))) score.haiku += 1
  if (tools.some(t => EDITS.includes(t))) score.sonnet += 1
  if (tools.includes('Bash') && tools.filter(t => EDITS.includes(t)).length >= 3) score.opus += 1

  const ranked = FAMILIES.map(m => [m, score[m]] as const).sort((a, b) => b[1] - a[1])
  const [top, second] = ranked
  let model: Auto = top && second && top[1] > second[1] ? top[0] : 'sonnet'
  // Hysteresis: stay on the current model unless the new one beats it by more than HYSTERESIS (softmax share).
  // Only for tiers the router scores: Fable has no score, so it never takes part.
  const total = FAMILIES.reduce((s, m) => s + Math.exp(score[m]), 0)
  const share = (m: Auto) => Math.exp(score[m]) / total
  const cur = isAuto(input.current) ? input.current : null
  if (cur && cur !== model && share(model) - share(cur) <= HYSTERESIS) model = cur
  const effort: Effort =
    model === 'haiku' ? 'low'
    : model === 'sonnet' ? (score.sonnet >= 2 ? 'medium' : 'low')
    : DEEP.test(text) || input.subagentType === 'Plan' ? 'xhigh'
    : heavy >= 2 ? 'high'
    : 'medium'
  // Confidence from the margin over the runner-up, kept to 0.50–0.99
  const margin = (top?.[1] ?? 0) - (second?.[1] ?? 0)
  const conf = Math.min(0.99, Math.max(0.5, 0.5 + 0.5 * (1 - Math.exp(-margin))))

  return { model, effort, conf: Math.round(conf * 100) / 100 }
}

// The effort for a tier chosen by something other than pickRoute (Jev): the same ladder, without the scores
export function effortFor(model: Model, text: string, subagentType?: string): Effort {
  if (model === 'haiku') return 'low'
  if (model === 'sonnet') return 'medium'
  return DEEP.test(text) || subagentType === 'Plan' ? 'xhigh' : 'high'
}

// The signals behind a pick, as the band's dim second line: “excerpt” · kw:debug · len 212 · tools Bash·Edit
export function whyOf(input: RouteInput): string {
  const kw = (input.text.match(HEAVY) ?? input.text.match(MID) ?? input.text.match(LIGHT) ?? [])[0]?.toLowerCase()
  const excerpt = input.text.replace(/\s+/g, ' ').trim().slice(0, 40)
  const tools = [...new Set(input.tools)].slice(-3)
  return [
    excerpt ? `“${excerpt}${input.text.length > 40 ? '…' : ''}”` : '',
    input.subagentType ? `agent:${input.subagentType}` : '',
    kw ? `kw:${kw}` : '',
    `len ${input.text.length}`,
    tools.length > 0 ? `tools ${tools.join('·')}` : 'no tools',
  ]
    .filter(Boolean)
    .join(' · ')
}
