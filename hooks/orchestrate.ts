import type { Effort, Model, Price, Prices, Source, Task, Who } from '../types'
import { capEffort } from './guard'
import { effortFor, familyOf, isPlanner } from './route'

// Pure helpers for the orchestrator mode: who set a sub-agent's model and effort, what an agent file says, and which
// environment variables override every choice. No mods API calls here: the hooks hand in the files and variables.

// The top-level scalars of an agent file's frontmatter that the router cares about
export type Front = { name?: string; model?: string; effort?: string; maxTurns?: string }

// "key: value" lines between the first two "---" lines. Only top-level keys (no indent); quotes and a trailing
// comment are dropped. Anything else in the file is ignored.
export function parseFrontmatter(text: string): Front {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out: Front = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const m = /^(name|model|effort|maxTurns):\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const value = (m[2] ?? '').replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2').trim()
    if (value) out[m[1] as keyof Front] = value
  }
  return out
}

// The agent types the engine ships. Their definitions set no model of their own that the router should respect,
// so the router routes them (Explore is Haiku by its own definition, which is also where the router sends it).
const BUILTIN = ['explore', 'plan', 'general-purpose', 'claude', 'claude-code-guide', 'statusline-setup', 'web-fetch']
export const isBuiltin = (type: string | undefined): boolean => BUILTIN.includes((type ?? '').toLowerCase())

export type Facts = {
  // The Agent call's own model and effort parameters (what the orchestrating session chose for this one call)
  callModel?: string
  callEffort?: string
  // The agent file's frontmatter, or null when no definition could be read
  front: Front | null
  builtin: boolean
  fork: boolean
  // CLAUDE_CODE_SUBAGENT_MODEL_FORCE on, and CLAUDE_CODE_EFFORT_LEVEL set to a level
  envModel: boolean
  envEffort: boolean
}

// Who sets the model and the effort of a spawn. The router routes a part only when no one else set it: precedence is
// env override, then the Agent call, then the agent file. A fork, or an agent whose file could not be read and that
// is not built in, is left to the engine ('default'): the router will not guess over a choice it cannot see.
export function whoSets(f: Facts): Who {
  const blind = f.fork || (f.front === null && !f.builtin)
  const pick = (env: boolean, call: string | undefined, file: string | undefined): Source =>
    f.fork ? 'default' : env ? 'env' : call ? 'orchestrator' : file ? 'frontmatter' : blind ? 'default' : 'router'
  return { model: pick(f.envModel, f.callModel, f.front?.model), effort: pick(f.envEffort, f.callEffort, f.front?.effort) }
}

export const isRouted = (s: Source): boolean => s === 'router'

// The effort for a model the router did not choose, when nobody set the effort either: the router's ladder for that
// model, held to medium unless the agent plans (a sub-agent is never above medium otherwise), and to the user's cap.
export function effortForHeld(model: Model, text: string, subagentType: string | undefined, maxEffort: Effort): Effort {
  return capEffort(effortFor(model, text, subagentType), isPlanner(subagentType) ? maxEffort : 'medium')
}

// The deck's "set by" text: one word when both came from the same place, else each part named
export function byText(by: Who | undefined): string {
  if (!by) return 'unknown'
  return by.model === by.effort ? by.model : `model ${by.model} · effort ${by.effort}`
}

// ── Agent files ─────────────────────────────────────────────────────────────────────────────────────────────

// Reads and lists through the engine's file system; each resolves to null/[] where the path is missing
export type Io = {
  read: (path: string) => Promise<string | null>
  list: (path: string) => Promise<{ name: string; kind: string }[]>
}

const trimEnd = (p: string) => p.replace(/[\\/]+$/, '')

// A directory's .md files, recursively to a few levels (agent files may sit in subfolders)
async function scan(dir: string, type: string, io: Io, depth: number): Promise<Front | null> {
  for (const entry of await io.list(dir)) {
    const path = `${trimEnd(dir)}/${entry.name}`
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
      const front = parseFrontmatter((await io.read(path)) ?? '')
      if (front.name === type) return front
    } else if (entry.kind === 'dir' && depth > 0) {
      const hit = await scan(path, type, io, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

// The frontmatter of an agent type, searched in the given agents folders in order (nearest first). A plugin's
// "plugin:name" is its file name under the plugin's agents folder ("plugin:sub:name" is sub/name.md). A plain name
// is its own file, else any .md in the folder whose frontmatter names it. Null when no definition is found.
export async function findFront(type: string, dirs: readonly string[], io: Io): Promise<Front | null> {
  const colon = type.indexOf(':')
  const stem = colon >= 0 ? type.slice(colon + 1).split(':').join('/') : type
  for (const dir of dirs) {
    const direct = await io.read(`${trimEnd(dir)}/${stem}.md`)
    if (direct !== null) return parseFrontmatter(direct)
    if (colon >= 0) continue
    const hit = await scan(dir, type, io, 2)
    if (hit) return hit
  }
  return null
}

// A folder and its parents, nearest first, up to a few levels: where a project's .claude/agents may live
export function ancestors(cwd: string, levels = 6): string[] {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const out: string[] = []
  for (let i = parts.length; i > 0 && out.length < levels; i--) {
    const dir = parts.slice(0, i).join('/')
    // A drive ("C:") or the filesystem root ("") is a folder too, but only once
    out.push(dir === '' ? '/' : dir)
  }
  return out
}

// The agents folders to search for an unscoped type: the project's (and its parents'), then the user's
export function agentDirs(cwd: string, home: string | undefined): string[] {
  const root = (d: string) => `${d === '/' ? '' : d}/.claude/agents`
  return [...ancestors(cwd).map(root), ...(home ? [root(home.replace(/\\/g, '/'))] : [])]
}

// ── Environment overrides ───────────────────────────────────────────────────────────────────────────────────

export type EnvFacts = { force: boolean; effort: boolean; model: string | undefined; effortValue: string | undefined }

const OFF = ['', '0', 'false', 'off', 'no']
const NO_LEVEL = ['', 'auto', 'unset']

export function envFacts(get: { force?: string; model?: string; effort?: string }): EnvFacts {
  return {
    force: get.force !== undefined && !OFF.includes(get.force.trim().toLowerCase()),
    effort: get.effort !== undefined && !NO_LEVEL.includes(get.effort.trim().toLowerCase()),
    model: get.model?.trim() || undefined,
    effortValue: get.effort?.trim() || undefined,
  }
}

// What to tell the person at session start: these two variables override every choice the orchestrator makes
export function envWarnings(f: EnvFacts): string[] {
  return [
    ...(f.force
      ? [`CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on${f.model ? ` (model ${f.model})` : ''}: every sub-agent runs on that one model, so agent-file and per-call model choices are ignored`]
      : []),
    ...(f.effort ? [`CLAUDE_CODE_EFFORT_LEVEL=${f.effortValue}: that effort overrides every agent's effort, the agent files' and the per-call ones`] : []),
  ]
}

// ── Prices and cost ─────────────────────────────────────────────────────────────────────────────────────────

const FAMILIES: Model[] = ['haiku', 'sonnet', 'opus', 'fable']
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

// A price file's text as a table. Anything that is not a non-negative number is "not filled in" (null); a file
// that does not parse is an empty table. Nothing is ever defaulted to a number.
export function parsePrices(text: string | null): Prices {
  let raw: unknown
  try {
    raw = text ? JSON.parse(text) : null
  } catch {
    raw = null
  }
  const models = (raw as { models?: Record<string, Record<string, unknown>> } | null)?.models ?? {}
  const out: Prices = {}
  for (const m of FAMILIES) {
    const row = models[m] ?? {}
    out[m] = { input: num(row.input), output: num(row.output), cacheWrite: num(row.cacheWrite), cacheRead: num(row.cacheRead) }
  }
  return out
}

// The user's file overrides the shipped one, field by field, where it has a number
export function mergePrices(base: Prices, over: Prices): Prices {
  const out: Prices = {}
  for (const m of FAMILIES) {
    const a = base[m]
    const b = over[m]
    out[m] = Object.fromEntries(FIELDS.map(f => [f, b?.[f] ?? a?.[f] ?? null])) as Price
  }
  return out
}

export const pricesEmpty = (p: Prices): boolean => FAMILIES.every(m => FIELDS.every(f => (p[m]?.[f] ?? null) === null))

// What a row spent, in its model's prices: fresh input, cache writes, cache reads, output. Null when a price that
// the row needs (it used that kind of token) is not filled in.
export type Use = { tokensIn?: number; tokensWrite?: number; tokensCached?: number; tokensOut?: number }
export function costOf(model: string | null, use: Use, prices: Prices): number | null {
  const write = use.tokensWrite ?? 0
  const family = model ? familyOf(model) : null
  const row = family ? prices[family] : undefined
  const parts: [number, number | null | undefined][] = [
    [Math.max(0, (use.tokensIn ?? 0) - write), row?.input],
    [use.tokensOut ?? 0, row?.output],
    [write, row?.cacheWrite],
    [use.tokensCached ?? 0, row?.cacheRead],
  ]
  let usd = 0
  for (const [tokens, perMillion] of parts) {
    if (tokens === 0) continue
    if (perMillion === null || perMillion === undefined) return null
    usd += (tokens / 1_000_000) * perMillion
  }
  return usd
}

export const fmtUsd = (usd: number | null): string => (usd === null ? 'prices missing' : `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`)

// ── The deck as text ────────────────────────────────────────────────────────────────────────────────────────

const n = (v: number | null | undefined) => String(v ?? 0)
const clock = (s: number | null) => (s === null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)

// The cost of everything the deck lists. Rows whose prices are missing are counted, not guessed.
export function deckCost(tasks: readonly Task[], prices: Prices): { known: number; missing: number; rows: number } {
  let known = 0
  let missing = 0
  let rows = 0
  const add = (model: string | null, use: Use) => {
    rows += 1
    const c = costOf(model, use, prices)
    if (c === null) missing += 1
    else known += c
  }
  for (const t of tasks) {
    add(t.model, t)
    for (const a of t.agents) add(a.model, a)
  }
  return { known, missing, rows }
}

// The deck's total cost as text: a sum, a partial sum with the rows that lack a price, or "prices missing"
export function moneyText(c: { known: number; missing: number; rows: number }): string {
  if (c.missing === 0) return fmtUsd(c.known)
  return c.missing === c.rows ? 'prices missing' : `${fmtUsd(c.known)} + prices missing for ${c.missing} of ${c.rows} rows`
}

// A turn's main-thread tokens against its sub-agents', with what each cost, and the manager guard's refusals.
// A high block count means the orchestrator keeps reaching for tools the rules say to delegate.
export function splitLine(t: Task, prices: Prices): string {
  const main = (t.tokensIn ?? 0) + (t.tokensOut ?? 0)
  const subs = t.agents.reduce((k, a) => k + (a.tokensIn ?? 0) + (a.tokensOut ?? 0), 0)
  const all = main + subs
  const share = (v: number) => (all === 0 ? '—' : `${Math.round((v / all) * 100)}%`)
  const mainCost = costOf(t.model, t, prices)
  const subCosts = t.agents.map(a => costOf(a.model, a, prices))
  const subCost = subCosts.some(c => c === null) ? null : subCosts.reduce<number>((k, c) => k + (c ?? 0), 0)
  return `main in+out ${main} (${share(main)}) · agents in+out ${subs} (${share(subs)}) · cost main ${fmtUsd(mainCost)} · agents ${t.agents.length === 0 ? '$0.0000' : fmtUsd(subCost)} · guard blocks ${t.blocks ?? 0}`
}

// /cr-deck: the deck as plain text, exact figures, one line per sub-agent under its task. Task-level tokens are the
// session's own turn (the orchestrator); a sub-agent's are its own run. The total adds both, tokens and cost.
export function deckText(tasks: readonly Task[], prices: Prices = {}): string {
  if (tasks.length === 0) return 'No task yet.'
  const all = { in: 0, cached: 0, out: 0 }
  const lines: string[] = []
  const cost = (model: string | null, use: Use) => fmtUsd(costOf(model, use, prices))
  for (const t of tasks) {
    lines.push(`task · ${t.name} · ${t.model ?? '—'} · ${t.effort ?? '—'} · ${t.status} · in ${n(t.tokensIn)} · cached ${n(t.tokensCached)} · out ${n(t.tokensOut)} · ${cost(t.model, t)} · ${clock(t.seconds)}`)
    all.in += t.tokensIn ?? 0
    all.cached += t.tokensCached ?? 0
    all.out += t.tokensOut ?? 0
    lines.push(`  ⇄ ${splitLine(t, prices)}`)
    for (const a of t.agents) {
      lines.push(`  └ ${a.type ?? '—'} · ${a.name} · ${a.model ?? '—'} · ${a.effort ?? '—'} · set by ${byText(a.by)} · ${a.status} · in ${n(a.tokensIn)} · cached ${n(a.tokensCached)} · out ${n(a.tokensOut)} · ${cost(a.model, a)} · ${clock(a.seconds)}`)
      all.in += a.tokensIn ?? 0
      all.cached += a.tokensCached ?? 0
      all.out += a.tokensOut ?? 0
    }
  }
  lines.push(`total · in ${all.in} · cached ${all.cached} · out ${all.out} · in+out ${all.in + all.out} · cost ${moneyText(deckCost(tasks, prices))}`)
  return lines.join('\n')
}
