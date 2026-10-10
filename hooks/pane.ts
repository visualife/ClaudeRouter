import type { RenderElement } from 'claude-code'
import type { Agent, Task } from '../types'
import { accentOf, bar, crab, MODEL_TONE, toneOf, type Els, type Snapshot } from './band'
import { fmtFit, fmtPct, fmtTime, fmtTokens } from './format'
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
  status: Task['status']
  seconds: number | null
  startedAt: number
  indent: boolean
}

// Context % is the main conversation's, so only its running task shows it; no agent has its own reading
function rowsOf(tasks: Task[], ctx: string): Row[] {
  return tasks.flatMap((task): Row[] => [
    {
      key: task.id,
      name: task.name,
      role: 'router',
      model: task.model,
      effort: task.effort,
      ctx: task.status === 'running' ? ctx : '—',
      tokens: task.tokens,
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
      status: a.status,
      seconds: a.seconds,
      startedAt: a.startedAt,
      indent: true,
    })),
  ])
}

function col(els: Els, width: number, text: string, props: { bold?: boolean; color?: string } = {}): RenderElement {
  return els.Box({ width, children: [els.Text({ children: [text], ...props })] })
}

// A row: its crab beside two lines, name · role · model · effort · state over ctx · tokens · time and the bar
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
          col(els, 26, `${r.indent && !crabs ? '└ ' : ''}${fmtFit(r.name, 24)}`, { bold: true }),
          col(els, 11, r.role, { color: 'claude' }),
          Text({ children: [`${family ?? '—'} · ${r.effort ?? '—'} · ${r.status}`], color: family ? MODEL_TONE[family] : 'subtle' }),
        ],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          bar(els, `row-${r.key}`, t, Math.max(8, Math.min(36, t.columns - (crabs ? 52 : 30))), toneOf(r.status), null, accentOf(r.model)),
          Text({ children: [`ctx ${r.ctx} · ${r.tokens === null ? '—' : fmtTokens(r.tokens)} · ${fmtTime(seconds)}`], color: 'subtle' }),
          Text({ children: [mark], color: r.status === 'failed' ? 'error' : running ? 'claude' : 'success' }),
        ],
      }),
    ],
  })
  if (!crabs) return lines
  return Box({ flexDirection: 'row', columnGap: 1, children: [crab(els, t, `crab-${r.key}`, r.role, running), lines] })
}

function section(els: Els, t: Snapshot, title: string, rows: Row[], crabs: boolean): RenderElement[] {
  const head = els.Text({ children: [`▾ ${title} · ${rows.length}`], bold: true })
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
      children: [Text({ children: [title], color: 'subtle' }), Text({ children: [value], bold: true })],
    })
  const cost = t.usage?.cost ?? null
  const started = t.usage?.startedAt ?? 0
  const rows = rowsOf(t.tasks, fmtPct(t.usage?.context.percent))
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
          Text({ children: [current ? fmtFit(current.name, Math.max(20, t.columns - 40)) : 'No task yet'], bold: true }),
          Text({ children: [r ? `route: ${r.model} · ${r.effort} · conf ${r.conf.toFixed(2)}` : 'route: —'], color: 'subtle' }),
        ],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          card('Cost', cost === null ? '—' : `≈$${cost.toFixed(2)}`),
          card('Tokens', fmtTokens(t.totals.tokens)),
          card('Time', started > 0 ? fmtTime((t.now - started) / 1000) : '—'),
        ],
      }),
      Box({ flexDirection: 'column', children: section(els, t, 'Running', running, crabs) }),
      Box({ flexDirection: 'column', children: section(els, t, 'Finished', rows.filter(x => x.status !== 'running'), crabs) }),
    ],
  })
}
