import type { Prices, Who } from '../types'
import { costOf, fmtUsd } from './orchestrate'

// The session log: one JSON line per event, written by the mod's hooks and never by a model. Every line is built by a
// constructor below from named fields only, so nothing else (a tool payload, a prompt body, a file's contents, an
// environment value) can reach the file. Text fields are cut short: a prompt to 120 characters, a name to 60.

export type Line = { t: string; at: number; [field: string]: unknown }

export const clip = (value: unknown, n: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export type Tokens = { tokensIn?: number; tokensWrite?: number; tokensCached?: number; tokensOut?: number }

// ── Line constructors ───────────────────────────────────────────────────────────────────────────────────────

export const sessionLine = (at: number, phase: 'start' | 'end', project: string, mode: string): Line => ({ t: 'session', at, phase, project: clip(project, 60), mode })

export const taskLine = (at: number, n: number, text: string, mode: string): Line => ({ t: 'task', at, n, text: clip(text, 120), mode })

export const launchLine = (at: number, n: number, a: { id: string; type: string; model: string; effort: string | null; by: Who; brief: string; skills: string[] }): Line => ({
  t: 'agent', at, n, id: clip(a.id, 60), agent: clip(a.type, 60), model: clip(a.model, 60), effort: a.effort, by: { model: a.by.model, effort: a.by.effort },
  brief: clip(a.brief.split(/\r?\n/).find(l => l.trim() !== '') ?? '', 120), skills: a.skills.slice(0, 10).map(s => clip(s, 60)),
})

export const skillLine = (at: number, n: number, s: { agent: string; id: string; skill: string; named: boolean }): Line => ({ t: 'skill', at, n, agent: clip(s.agent, 60), id: clip(s.id, 60), skill: clip(s.skill, 80), named: s.named })

export const mcpLine = (at: number, n: number, m: { agent: string; id: string; server: string; tool: string }): Line => ({ t: 'mcp', at, n, agent: clip(m.agent, 60), id: clip(m.id, 60), server: clip(m.server, 60), tool: clip(m.tool, 80) })

export type End = 'ended' | 'maxTurns' | 'failed'
export const endLine = (at: number, n: number, e: { id: string; agent: string; model: string; in: number; cached: number; out: number; cost: number | null; sec: number; turns: number; end: End }): Line => ({
  t: 'end', at, n, id: clip(e.id, 60), agent: clip(e.agent, 60), model: clip(e.model, 60), in: num(e.in), cached: num(e.cached), out: num(e.out), cost: e.cost, sec: Math.round(num(e.sec)), turns: num(e.turns), end: e.end,
})

export const mainLine = (at: number, n: number, m: { model: string; effort: string | null; in: number; cached: number; out: number; cost: number | null; sec: number }): Line => ({
  t: 'main', at, n, model: clip(m.model, 60), effort: m.effort, in: num(m.in), cached: num(m.cached), out: num(m.out), cost: m.cost, sec: Math.round(num(m.sec)),
})

export const blockLine = (at: number, n: number, b: { tool: string; target: string; agent: string }): Line => ({ t: 'block', at, n, tool: clip(b.tool, 40), target: clip(b.target, 200), agent: clip(b.agent, 40) })

export const followLine = (at: number, n: number, agent: string): Line => ({ t: 'followup', at, n, agent: clip(agent, 60) })

export type VerdictWord = 'pass' | 'fail' | 'not checked'
export const verdictLine = (at: number, n: number, v: { id: string; verdict: VerdictWord; pass: number; fail: number; unchecked: number }): Line => ({ t: 'verdict', at, n, id: clip(v.id, 60), verdict: v.verdict, pass: v.pass, fail: v.fail, unchecked: v.unchecked })

// ── Reading what the lines need ─────────────────────────────────────────────────────────────────────────────

// The skills a brief names on a "Skills: a, b" line (the orchestrator rules ask for one). Names only.
export function skillsNamed(brief: string): string[] {
  const m = /^\s*(?:[-*]\s*)?skills?(?:\s+to\s+invoke)?\s*:\s*(.+)$/im.exec(brief)
  if (!m) return []
  const line = m[1] ?? ''
  const clean = (s: string) => s.replace(/[`'"*.]/g, '').trim()
  const isName = (s: string) => /^[a-z0-9][\w:.-]*$/i.test(s) && !/^(none|n\/a)$/i.test(s)
  // A list ("a, b"): every item is one name. A sentence: only the plugin:skill tokens in it.
  const items = line.split(',').map(clean)
  const names = items.every(i => isName(i) || i === '') ? items.filter(isName) : line.split(/\s+/).map(clean).filter(t => t.includes(':') && isName(t))
  return names.slice(0, 10)
}

// A verifier's answer as one verdict and the counts behind it: any FAIL fails; all PASS passes; otherwise not checked.
// Only the words are counted: nothing of the answer is kept.
export function verdictOf(answer: string): { verdict: VerdictWord; pass: number; fail: number; unchecked: number } {
  const count = (re: RegExp) => (answer.match(re) ?? []).length
  // A line counts when its first word is the verdict: bullets, bold marks and numbering ("1. FAIL") before it are skipped
  const pass = count(/^[^A-Za-z]*PASS\b/gm)
  const fail = count(/^[^A-Za-z]*FAIL\b/gm)
  const unchecked = count(/^[^A-Za-z]*NOT CHECKED\b/gm)
  return { verdict: fail > 0 ? 'fail' : pass > 0 && unchecked === 0 ? 'pass' : 'not checked', pass, fail, unchecked }
}

// ── Where the files go ──────────────────────────────────────────────────────────────────────────────────────

const two = (v: number) => String(v).padStart(2, '0')
export const stamp = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}
export const dateOf = (at: number): string => stamp(at).slice(0, 10)

export const projectName = (cwd: string): string => clip(cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project', 60).replace(/[^\w.-]+/g, '_') || 'project'

export type LogPaths = { dir: string; jsonl: string; md: string }
export function logPaths(home: string, cwd: string, at: number, sessionId: string): LogPaths {
  const dir = `${home.split('\\').join('/').replace(/\/+$/, '')}/.claude/cr-logs/${projectName(cwd)}`
  const name = `${stamp(at)}-${clip(sessionId, 40).replace(/[^\w-]+/g, '_') || 'session'}`
  return { dir, jsonl: `${dir}/${name}.jsonl`, md: `${dir}/${name}.md` }
}

export const toJsonl = (lines: readonly Line[]): string => lines.map(l => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '')
export function fromJsonl(text: string): Line[] {
  const out: Line[] = []
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue
    try {
      const v = JSON.parse(row) as Line
      if (typeof v.t === 'string') out.push(v)
    } catch {
      // a half-written line is skipped
    }
  }
  return out
}

// ── The summary ─────────────────────────────────────────────────────────────────────────────────────────────

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const n = (v: unknown) => num(v)
const cell = (s: string) => s.replace(/\|/g, '/')
const clock = (sec: number) => `${Math.floor(sec / 60)}:${two(Math.round(sec % 60))}`
const usd = (c: number | null | undefined) => fmtUsd(c ?? null)
// A cost cell that stays "prices missing" unless every part is priced
const money = (costs: readonly (number | null)[]) => (costs.length > 0 && costs.every(c => c !== null) ? fmtUsd(sum(costs as number[])) : costs.length === 0 ? fmtUsd(0) : 'prices missing')

export type Totals = {
  byModel: Record<string, { in: number; cached: number; out: number; costs: (number | null)[] }>
  main: { in: number; out: number }
  agents: { in: number; out: number }
  costs: (number | null)[]
  blocks: number
  followups: number
  seconds: number
}

// The session's totals, summed from the lines and from nothing else
export function totalsOf(lines: readonly Line[], now?: number): Totals {
  const byModel: Totals['byModel'] = {}
  const add = (model: string, l: Line) => {
    const row = (byModel[model] ??= { in: 0, cached: 0, out: 0, costs: [] })
    row.in += n(l.in)
    row.cached += n(l.cached)
    row.out += n(l.out)
    row.costs.push((l.cost as number | null) ?? null)
  }
  const main = { in: 0, out: 0 }
  const agents = { in: 0, out: 0 }
  const costs: (number | null)[] = []
  for (const l of lines) {
    if (l.t === 'main') {
      add(str(l.model) || '—', l)
      main.in += n(l.in)
      main.out += n(l.out)
      costs.push((l.cost as number | null) ?? null)
    } else if (l.t === 'end') {
      add(str(l.model) || '—', l)
      agents.in += n(l.in)
      agents.out += n(l.out)
      costs.push((l.cost as number | null) ?? null)
    }
  }
  const first = lines.find(l => l.t === 'session')?.at ?? lines[0]?.at ?? 0
  const last = lines.findLast(l => l.t === 'session' && l.phase === 'end')?.at ?? now ?? lines.at(-1)?.at ?? first
  return {
    byModel, main, agents, costs,
    blocks: lines.filter(l => l.t === 'block').length,
    followups: lines.filter(l => l.t === 'followup').length,
    seconds: Math.max(0, Math.round((last - first) / 1000)),
  }
}

// The readable summary: one table per task (part, agent, model, effort, skills, tokens, cost, time, result), then the
// session totals. Every figure comes from the lines.
export function mdOf(lines: readonly Line[], now?: number): string {
  const out: string[] = []
  const project = str(lines.find(l => l.t === 'session')?.project)
  out.push(`# Session log · ${project}`, '')
  for (const task of lines.filter(l => l.t === 'task')) {
    const k = task.n
    out.push(`## Task ${n(k)} · ${cell(str(task.text))}`, '', `Orchestrator: ${str(task.mode)}`, '')
    out.push('| Part | Agent | Model | Effort | Skills | Tokens in / cached / out | Cost | Time | Result |', '|---|---|---|---|---|---|---|---|---|')
    const mains = lines.filter(l => l.t === 'main' && l.n === k)
    if (mains.length > 0) {
      const costs = mains.map(l => (l.cost as number | null) ?? null)
      out.push(`| orchestrator | main | ${cell(str(mains.at(-1)?.model))} | ${cell(str(mains.at(-1)?.effort))} | ${cell([...new Set(lines.filter(l => l.t === 'skill' && l.n === k && l.id === 'main').map(l => str(l.skill)))].join(', '))} | ${sum(mains.map(l => n(l.in)))} / ${sum(mains.map(l => n(l.cached)))} / ${sum(mains.map(l => n(l.out)))} | ${money(costs)} | ${clock(sum(mains.map(l => n(l.sec))))} | ${lines.filter(l => l.t === 'block' && l.n === k).length} guard blocks |`)
    }
    for (const a of lines.filter(l => l.t === 'agent' && l.n === k)) {
      const end = lines.find(l => l.t === 'end' && l.id === a.id)
      const verdict = lines.find(l => l.t === 'verdict' && l.id === a.id)
      const used = [...new Set(lines.filter(l => l.t === 'skill' && l.id === a.id).map(l => str(l.skill)))]
      const follow = lines.filter(l => l.t === 'followup' && l.n === k && l.agent === a.agent).length
      const result = end ? `${str(end.end)}${verdict ? ` · ${str(verdict.verdict)}` : ''}${follow > 0 ? ` · ${follow} follow-up` : ''}` : 'running'
      out.push(`| ${cell(str(a.brief))} | ${cell(str(a.agent))} | ${cell(str(a.model))} | ${cell(str(a.effort))} | ${cell(used.join(', '))} | ${end ? `${n(end.in)} / ${n(end.cached)} / ${n(end.out)}` : '—'} | ${end ? usd(end.cost as number | null) : '—'} | ${end ? clock(n(end.sec)) : '—'} | ${result} |`)
    }
    out.push('')
  }
  const t = totalsOf(lines, now)
  out.push('## Session totals', '', '| Model | In | Cached | Out | Cost |', '|---|---|---|---|---|')
  for (const [model, row] of Object.entries(t.byModel)) out.push(`| ${cell(model)} | ${row.in} | ${row.cached} | ${row.out} | ${money(row.costs)} |`)
  const all = t.main.in + t.main.out + t.agents.in + t.agents.out
  out.push('', `- Main-thread share: ${all === 0 ? '—' : `${Math.round(((t.main.in + t.main.out) / all) * 100)}%`} of in+out (${t.main.in + t.main.out} of ${all})`)
  out.push(`- Cost: ${money(t.costs)}`, `- Wall-clock: ${clock(t.seconds)}`, `- Guard blocks: ${t.blocks} · follow-ups: ${t.followups}`, '')
  return out.join('\n')
}

// ── The review ──────────────────────────────────────────────────────────────────────────────────────────────

export const REVIEW_AGENT = 'log-review'

// The brief of the review agent. It names the files it may read; the hook refuses every other path.
export function reviewPrompt(files: readonly string[], project: string): string {
  return [
    `Review the ClaudeRouter session logs of the project "${project}". Read only these ${files.length} files (JSON lines, one event per line), nothing else:`,
    ...files.map(f => `- ${f}`),
    '',
    'Line types (field t): session (phase start|end), task (n, text, mode), agent (n, id, agent, model, effort, by{model,effort}, brief, skills = named in the brief), end (n, id, agent, model, in, cached, out, cost|null, sec, turns, end = ended|maxTurns|failed), main (n, model, in, cached, out, cost|null, sec), skill (agent, id, skill, named = the brief named it), mcp (agent, server, tool), block (tool, target, agent = the agent the guard suggested), followup (n, agent = the agent the orchestrator sent back), verdict (id, verdict pass|fail|not checked).',
    '',
    'Report, in this order, as Markdown:',
    '1. Per agent and model: tasks, average cost and time, follow-up rate (followups / launches), verifier fail rate, maxTurns hits. Cost null means prices were missing: say so, do not guess.',
    '2. Skills: named in briefs but never invoked; invoked without being named; never used at all in the period.',
    '3. Routing: task types (by the task text) that kept needing a higher model or effort, and ones that could go lower.',
    '4. Guard blocks by tool and by suggested agent.',
    '5. At most five proposed changes. Each is an exact edit to an agent file (~/.claude/agents/<name>.md), a routing table (~/.claude/routing/<name>.md) or ~/.claude/orchestrator.md: the file, the old text, the new text, and the evidence as line counts (for example "7 of 9 coder end lines hit maxTurns"). No change without counts behind it.',
    '',
    'You change nothing and write no file: your answer is the review. Do not quote file contents beyond event names and counts.',
  ].join('\n')
}
