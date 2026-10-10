import type { Model } from '../types'
import type { RouteInput } from './route'

// Jev (TypeSafe System One) as the judge: one Choice question over the three tiers.
// It picks the tier; Claude still does the work. Any failure returns null and the caller falls back to the rules.
const URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_TIMEOUT_MS = 2500
const TIERS: Model[] = ['haiku', 'sonnet', 'opus']

export type JevFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; text: string }>

// jev-1.13: 64k tokens per request (docs.typesafe.ai/models)
export const JEV_WINDOW = 64_000

export type JevPick = { model: Model; conf: number; input: number; output: number }

export function jevBody(input: RouteInput) {
  return {
    model: 'jev-latest',
    state: {
      request: input.text.slice(0, 4000),
      agent: input.subagentType ?? 'main conversation',
      tools_used_this_turn: [...new Set(input.tools)].slice(-8),
    },
    questions: {
      route: {
        type: 'choice',
        instructions: 'Which Claude model tier is the cheapest one that will do this request well?',
        choice: {
          haiku: 'Lookups, listing, reading, renaming, formatting, short summaries; no real reasoning.',
          sonnet: 'Ordinary implementation: writing code, fixing a known bug, tests, small multi-file edits.',
          opus: 'Architecture, planning, hard debugging, security, ambiguous or cross-cutting work.',
        },
      },
    },
  }
}

export async function askJev(fetch: JevFetch, key: string, input: RouteInput): Promise<JevPick | null> {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jevBody(input)),
    })
    if (!res.ok) return null
    const body = JSON.parse(res.text)
    const answer = body?.answers?.route
    const model = TIERS.find(t => t === answer?.choice)
    const p = answer?.probabilities?.[model ?? '']
    if (!model || typeof p !== 'number' || !Number.isFinite(p)) return null
    const inTok = Number(body?.usage?.input_tokens)
    const outTok = Number(body?.usage?.output_tokens)
    return {
      model,
      conf: Math.round(Math.min(0.99, Math.max(0.5, p)) * 100) / 100,
      input: Number.isFinite(inTok) ? inTok : 0,
      output: Number.isFinite(outTok) ? outTok : 0,
    }
  } catch {
    return null
  }
}
