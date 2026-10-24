import type { Effort, Model } from '../types'
import type { RoutePick } from './route'

// Cost guards: pure limits applied on top of the router's pick, on every model request.
// The router decides what a prompt *looks like*; the guard decides what the turn may *cost*.

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh']
const MODELS: Model[] = ['haiku', 'sonnet', 'opus']
const rankE = (e: Effort) => EFFORTS.indexOf(e)
const rankM = (m: Model) => MODELS.indexOf(m)

export const capEffort = (e: Effort, max: Effort): Effort => (rankE(e) > rankE(max) ? max : e)
const capModel = (m: Model, max: Model): Model => (rankM(m) > rankM(max) ? max : m)

// Effort when a model is pinned without one
export const DEFAULT_EFFORT: Record<Model, Effort> = { haiku: 'low', sonnet: 'medium', opus: 'high' }

// Opus may plan: it keeps the first requests of a turn, then the turn moves to Sonnet
export const OPUS_STEPS = 2
// A prompt longer than this is a spec, not a question: Opus on it never runs above medium
export const LONG_PROMPT = 1200
// This many tool calls in one turn = it is executing, not planning
export const EXEC_TOOLS = 6
const WRITES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export type Pin = { model: Model; effort: Effort | null }

export type GuardInput = {
  pick: RoutePick
  // The user's explicit choice (a turn directive or /clauderouter pin): wins over every limit
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
}

export type Guarded = { model: Model; effort: Effort; limits: string[] }

export function guard(i: GuardInput): Guarded {
  if (i.pin) {
    const effort = i.pin.effort ?? (i.pin.model === i.pick.model ? i.pick.effort : DEFAULT_EFFORT[i.pin.model])
    return { model: i.pin.model, effort, limits: ['pinned'] }
  }
  let { model, effort } = i.pick
  const limits: string[] = []

  if (rankE(effort) > rankE(i.maxEffort)) {
    effort = i.maxEffort
    limits.push(`effort≤${i.maxEffort}`)
  }

  // Plan with Opus, execute with Sonnet
  if (model === 'opus') {
    const executing = i.turnTools.some(t => WRITES.includes(t)) || i.turnTools.length >= EXEC_TOOLS
    if (i.isSub && !i.isPlan) {
      model = 'sonnet'
      effort = capEffort(effort, 'medium')
      limits.push('subagent→sonnet')
    } else if (!i.isSub && (i.step >= OPUS_STEPS || executing)) {
      model = 'sonnet'
      effort = capEffort(effort, 'medium')
      limits.push('opus plans only')
    } else if (i.textLen > LONG_PROMPT) {
      effort = capEffort(effort, 'medium')
      limits.push('long prompt')
    }
  }

  // A subagent is never above medium unless it plans
  if (i.isSub && !i.isPlan) effort = capEffort(effort, 'medium')

  if (i.ctxCap > 0 && i.contextTokens !== null && i.contextTokens > i.ctxCap) {
    model = capModel(model, 'sonnet')
    effort = capEffort(effort, i.contextTokens > i.ctxCap * 1.5 ? 'low' : 'medium')
    limits.push(`ctx ${Math.round(i.contextTokens / 1000)}k`)
  }

  if (i.budget > 0 && i.turnCost !== null && i.turnCost > i.budget) {
    model = capModel(model, 'sonnet')
    effort = capEffort(effort, i.turnCost > i.budget * 2 ? 'low' : 'medium')
    limits.push(`turn $${i.turnCost.toFixed(2)}>$${i.budget}`)
  }
  return { model, effort, limits }
}

// "@sonnet", "@opus:high", "@haiku:med" at the very start of a prompt pins that turn
const DIRECTIVE = /^\s*@(haiku|sonnet|opus)(?::(low|med|medium|high|xhigh))?(?=\s|$)/i

export function toEffort(s: string): Effort | null {
  const v = s.toLowerCase() === 'med' ? 'medium' : s.toLowerCase()
  return EFFORTS.find(e => e === v) ?? null
}

export function directiveOf(text: string): Pin | null {
  const m = DIRECTIVE.exec(text)
  if (!m) return null
  return { model: m[1]!.toLowerCase() as Model, effort: m[2] ? toEffort(m[2]) : null }
}
