import type { RenderElement } from 'claude-code'
import type { Agent, Task } from '../types'
import { accentOf, bar, crab, factRows, MODEL_TONE, taskBar, toneOf, warnRows, type Els, type Snapshot } from './band'
import { fmtFit, fmtPct, fmtTime, fmtTokens } from './format'
import { byText, costOf, deckCost, fmtUsd, moneyText, splitLine } from './orchestrate'
import type { Prices } from '../types'
import { familyOf } from './route'

// One line of the Running or Finished list: a task, or a subagent under it
type Row = {
  key: string
  name: string
  role: Agent['role'] | 'router'
  model: string | null
  effort: string | null
  ctx: string
  tokens: number | null
  // The bar's fill, in percent: a prompt's share spent by its sub-agents, an agent's share of its prompt. Null = unknown.
  share: number | null
  // Prompt tokens billed fresh, prompt tokens the cache served, and tokens written
  tokensIn: number | null
  tokensCached: number | null
  tokensOut: number | null
  // Its cost in the price table, as text ("prices missing" until the table is filled in)
  money: string
  // A subagent: its type, and who set its model and effort. Null on the session's own row.
  type: string | null
  by: Agent['by'] | null
  status: Task['status']
  seconds: number | null
  startedAt: number
  indent: boolean
}

// What a row spent, the way the row shows it: tokens in (fresh + cache writes), cached and out
type Spent = { tokens: number | null; tokensIn?: number | null; tokensCached?: number | null; tokensOut?: number | null }
function spentOf(x: Spent): number | null {
  if (x.tokensIn == null && x.tokensCached == null && x.tokensOut == null) return x.tokens
  return (x.tokensIn ?? 0) + (x.tokensCached ?? 0) + (x.tokensOut ?? 0)
}

// The share of a prompt's tokens (main thread + its sub-agents) spent by sub-agents. Without an agent: 0, not null.
// Null while the main thread's own figure is not in yet.
export function promptShare(task: Task): number | null {
  const main = spentOf(task)
  if (task.agents.length === 0) return 0
  if (main === null && task.status === 'running') return null
  const agents = task.agents.reduce((k, a) => k + (spentOf(a) ?? 0), 0)
  const all = (main ?? 0) + agents
  return all > 0 ? (agents / all) * 100 : 0
}

// One agent's share of its prompt's tokens. Null while it runs (its tokens arrive at its end).
export function agentShare(task: Task, a: Agent): number | null {
  if (a.status === 'running') return null
  const own = spentOf(a)
  const all = (spentOf(task) ?? 0) + task.agents.reduce((k, x) => k + (spentOf(x) ?? 0), 0)
  return own === null || all <= 0 ? null : (own / all) * 100
}

// Context % is the main conversation's, so only its running task shows it; no agent has its own reading
function rowsOf(tasks: Task[], ctx: string, prices: Prices): Row[] {
  return tasks.flatMap((task): Row[] => [
    {
      key: task.id,
      name: task.name,
      role: 'router',
      model: task.model,
      effort: task.effort,
      ctx: task.status === 'running' ? ctx : '—',
      tokens: task.tokens,
      share: promptShare(task),
      tokensIn: task.tokensIn ?? null,
      tokensCached: task.tokensCached ?? null,
      tokensOut: task.tokensOut ?? null,
      money: fmtUsd(costOf(task.model, task, prices)),
      type: null,
      by: null,
      status: task.status,
      seconds: task.seconds,
      startedAt: task.startedAt,
      indent: false,
    },
    ...task.agents.map((a, i): Row => ({
      key: `${task.id}-${a.id ?? i}`,
      name: a.name,
      role: a.role,
      model: a.model,
      effort: a.effort,
      ctx: '—',
      tokens: a.status === 'running' ? null : a.tokens,
      share: agentShare(task, a),
      tokensIn: a.status === 'running' ? null : (a.tokensIn ?? null),
      tokensCached: a.status === 'running' ? null : (a.tokensCached ?? null),
      tokensOut: a.status === 'running' ? null : (a.tokensOut ?? null),
      money: fmtUsd(costOf(a.model, a, prices)),
      type: a.type ?? null,
      by: a.by ?? null,
      status: a.status,
      seconds: a.seconds,
      startedAt: a.startedAt,
      indent: true,
    })),
  ])
}

// Primary text: a light grey, a touch under white, so it stays brighter than 'subtle'
const LIGHT = '#d4d4d4'

function col(els: Els, width: number, text: string, props: { color?: string } = {}): RenderElement {
  return els.Box({ width, children: [els.Text({ children: [text], color: LIGHT, ...props })] })
}

// The tokens of a row, in and out: "in 12k + 80k cached · out 1.2k", or "—" until it reports
function tokenText(r: Row): string {
  if (r.tokensIn === null && r.tokensOut === null) return `${fmtTokens(r.tokens)}`
  const cached = r.tokensCached ? ` + ${fmtTokens(r.tokensCached)} cached` : ''
  return `in ${fmtTokens(r.tokensIn)}${cached} · out ${fmtTokens(r.tokensOut)}`
}

// A row: its crab beside two lines. A subagent: its type and task · model · effort · who set them · state, over the
// bar and its tokens in and out · time. The session's own row keeps role · model · effort · state and ctx.
function rowView(els: Els, t: Snapshot, r: Row, crabs: boolean): RenderElement {
  const { Box, Text } = els
  const seconds = r.status === 'running' ? (t.now - r.startedAt) / 1000 : (r.seconds ?? 0)
  const family = r.model ? familyOf(r.model) : null
  const running = r.status === 'running'
  const mark = r.status === 'done' ? '✓' : r.status === 'failed' ? '✗' : t.frame % 10 < 5 ? '●' : '○'
  const lines = Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          r.type !== null
            ? col(els, 32, `${r.indent && !crabs ? '└ ' : ''}${fmtFit(r.type, 14)} · ${fmtFit(r.name, 14)}`)
            : col(els, 26, `${r.indent && !crabs ? '└ ' : ''}${fmtFit(r.name, 24)}`),
          ...(r.type !== null ? [] : [col(els, 11, r.role, { color: 'claude' })]),
          Text({ children: [`${family ?? '—'} · ${r.effort ?? '—'} · ${r.status}`], color: family ? MODEL_TONE[family] : 'subtle' }),
          ...(r.by !== null ? [Text({ children: [`set by ${byText(r.by)}`], color: 'subtle' })] : []),
        ],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          // The real value: a prompt's share of tokens spent by its sub-agents, an agent's share of its prompt
          bar(els, `row-${r.key}`, t, Math.max(6, Math.min(20, t.columns - (crabs ? 52 : 30))), toneOf(r.status), r.share, accentOf(r.model)),
          Text({ children: [`${r.type === null ? `ctx ${r.ctx} · ` : ''}${r.status === 'running' && r.type !== null ? '—' : `${tokenText(r)} · ${r.money}`} · ${fmtTime(seconds)}`], color: 'subtle' }),
          Text({ children: [mark], color: r.status === 'failed' ? 'error' : running ? 'claude' : 'success' }),
        ],
      }),
    ],
  })
  if (!crabs) return lines
  return Box({ flexDirection: 'row', columnGap: 1, children: [crab(els, t, `crab-${r.key}`, r.role, running), lines] })
}

function section(els: Els, t: Snapshot, title: string, rows: Row[], crabs: boolean): RenderElement[] {
  const head = els.Text({ children: [`▾ ${title} · ${rows.length}`], color: LIGHT })
  if (rows.length === 0) return [head, els.Text({ children: ['none'], color: 'subtle' })]
  return [head, ...rows.map(r => rowView(els, t, r, crabs))]
}

// The /ClaudeRouter pane: the current task and route, three cards, then the running and finished lists
export function drawPane(els: Els, t: Snapshot): RenderElement {
  const { Box, Text } = els
  const card = (title: string, value: string) =>
    Box({
      flexDirection: 'column',
      borderStyle: 'round',
      paddingX: 1,
      minWidth: 14,
      children: [Text({ children: [title], color: 'subtle' }), Text({ children: [value], color: LIGHT })],
    })
  const cost = t.usage?.cost ?? null
  const started = t.usage?.startedAt ?? 0
  const rows = rowsOf(t.tasks, fmtPct(t.usage?.context.percent), t.prices)
  const running = rows.filter(r => r.status === 'running')
  // The crabs are terminal Rasters and need width; past a few rows they would bury the list
  const crabs = t.terminal && t.columns >= 80 && rows.length <= 3
  const current = t.tasks.filter(task => task.status === 'running').at(-1) ?? t.tasks.at(-1)
  const r = t.route

  return Box({
    flexDirection: 'column',
    gap: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Text({ children: [current ? fmtFit(current.name, Math.max(20, t.columns - 40)) : 'No task yet'], color: LIGHT }),
          Text({ children: [r ? `route: ${r.model} · ${r.effort} · conf ${r.conf.toFixed(2)}` : 'route: —'], color: 'subtle' }),
        ],
      }),
      ...warnRows(els, t),
      ...taskBar(els, t),
      // main against sub-agents, and the guard's refusals (amber once there is one)
      ...(current ? [Text({ children: [splitLine(current, t.prices)], color: (current.blocks ?? 0) > 0 ? 'warning' : 'subtle' })] : []),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          card('Cost', cost === null ? '—' : `≈$${cost.toFixed(2)}`),
          card('Tokens', fmtTokens(t.totals.tokens)),
          card('Time', started > 0 ? fmtTime((t.now - started) / 1000) : '—'),
          card('Deck cost', moneyText(deckCost(t.tasks, t.prices))),
        ],
      }),
      Box({ flexDirection: 'column', children: factRows(els, t) }),
      Box({ flexDirection: 'column', children: section(els, t, 'Running', running, crabs) }),
      Box({ flexDirection: 'column', children: section(els, t, 'Finished', rows.filter(x => x.status !== 'running'), crabs) }),
    ],
  })
}
