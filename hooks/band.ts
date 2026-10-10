import type { Elements, RenderElement } from 'claude-code'
import type { JevUse, McpUse, Route, SkillUse, Task, Usage } from '../types'
import { JEV_WINDOW } from './jev'
import { familyOf } from './route'
import { ACCENT, type Anim, type Role, type Tone, barCells, packCells, spriteCells, SPRITE_COLUMNS, SPRITE_ROWS } from './pixel'
import { fmtFit, fmtPct, fmtTime, fmtTokens } from './format'

export type Els = Elements['terminal']

// Everything the drawings read, gathered by the hooks: the drawings take values, never $.
// `anim` is the one thing they write: the Rasters they mount that the timer repaints.
export type Snapshot = {
  route: Route | null
  tasks: Task[]
  skills: SkillUse[]
  mcp: McpUse[]
  plugins: string[]
  usage: Usage | null
  jev: JevUse | null
  totals: { tokens: number; turns: number }
  now: number
  frame: number
  terminal: boolean
  columns: number
  rows: number
  anim: Anim[]
}

// Text uses theme keys so light and dark both read; Rasters use the design's accents
export const MODEL_TONE = { haiku: 'success', sonnet: 'suggestion', opus: 'warning' } as const
const EFFORT_LEVEL = { low: 1, medium: 2, high: 3, xhigh: 4 } as const
const MODELS = ['haiku', 'sonnet', 'opus'] as const
const LABEL = 16
// The crew needs this many rows above the band's own before it is drawn
const CREW_MIN_ROWS = 22

export function accentOf(model: string | null): number {
  const family = model ? familyOf(model) : null
  return family ? ACCENT[family] : ACCENT.brand
}

// A bar: a Raster in the terminal, a Text row on the desktop, which has no Raster.
// A running bar with no total (pct null) shimmers; the terminal's timer repaints it with $.ui.blit.
export function bar(els: Els, key: string, t: Snapshot, width: number, tone: Tone, pct: number | null, accent: number): RenderElement {
  const cells = barCells(width, t.frame, tone, pct, accent)
  if (!t.terminal) {
    const color = tone === 'fail' ? 'error' : tone === 'done' ? 'success' : pct === null ? 'suggestion' : 'warning'
    return els.Text({ children: [cells.map(c => (c[0] === '⠂' ? '·' : '█')).join('')], color })
  }
  if (tone === 'run' && pct === null) t.anim.push({ key, kind: 'bar', width, accent })
  return els.Raster({ key, columns: width, rows: 1, cells: packCells([cells]) })
}

export function toneOf(status: Task['status']): Tone {
  return status === 'running' ? 'run' : status === 'done' ? 'done' : 'fail'
}

// One crab of the crew: running ones step and wave, the rest stand still
export function crab(els: Els, t: Snapshot, key: string, role: Role, running: boolean): RenderElement {
  if (running) t.anim.push({ key, kind: 'sprite', role })
  return els.Raster({ key, columns: SPRITE_COLUMNS, rows: SPRITE_ROWS, cells: spriteCells(role, 'still', t.frame) })
}

const barWidth = (t: Snapshot) => Math.max(8, Math.min(30, t.columns - 46))

function label(els: Els, glyph: string, text: string, color = 'subtle'): RenderElement {
  return els.Box({ width: LABEL, children: [els.Text({ children: [`${glyph} ${text}`], color })] })
}

function row(els: Els, children: RenderElement[]): RenderElement {
  return els.Box({ flexDirection: 'row', columnGap: 2, children })
}

function header(els: Els, t: Snapshot): RenderElement[] {
  const { Box, Text } = els
  const running = t.tasks.filter(task => task.status === 'running')
  const agents = running.flatMap(task => task.agents).filter(a => a.status === 'running')
  const sub = running.length === 0 ? 'idle' : agents.length > 0 ? `working · ${agents.length} agent${agents.length === 1 ? '' : 's'}` : 'working'
  const title = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [Text({ children: ['ClaudeRouter'], bold: true, color: 'claude' }), Text({ children: [`${sub} · turn ${t.totals.turns + running.length}`], color: 'subtle' })],
  })
  if (!t.terminal || t.rows < CREW_MIN_ROWS) return [title]
  const room = Math.max(0, Math.floor((t.columns - SPRITE_COLUMNS) / (SPRITE_COLUMNS + 1)))
  const crew = [
    crab(els, t, 'crab-router', 'router', running.length > 0),
    ...agents.slice(0, Math.min(4, room)).map((a, i) => crab(els, t, `crab-${i}`, a.role, true)),
  ]
  return [Box({ flexDirection: 'row', columnGap: 1, children: crew }), title]
}

function routeRows(els: Els, r: Route): RenderElement[] {
  const why = r.why
  const { Box, Text } = els
  const level = EFFORT_LEVEL[r.effort]
  const prev = familyOf(r.engineModel)
  const chips = MODELS.map(m =>
    Text({
      children: [m === prev && !r.kept ? `[${m}]` : ` ${m} `],
      color: MODEL_TONE[m],
      bold: m === r.model,
      inverse: m === r.model,
      dimColor: m !== r.model && m !== prev,
    }),
  )
  // Jev sits beside the tiers: lit when it made this pick, dim when the rules did
  chips.push(Text({ children: [' jev '], color: 'claude', bold: r.by === 'jev', inverse: r.by === 'jev', dimColor: r.by !== 'jev' }))
  const signal = [1, 2, 3, 4].map(i => Text({ children: ['▂▄▆█'[i - 1] ?? ' '], color: i <= level ? MODEL_TONE[r.model] : 'inactive' }))
  const confBar = '▬'.repeat(Math.round(r.conf * 5)).padEnd(5, '·')
  return [
    row(els, [
      label(els, '⇄', 'Model route'),
      Text({ children: [`${prev ?? '—'} =`], color: 'subtle' }),
      Box({ flexDirection: 'row', children: chips }),
      Box({ flexDirection: 'row', columnGap: 1, children: [Box({ flexDirection: 'row', children: signal }), Text({ children: [r.effort] })] }),
      Text({ children: [`conf ${confBar} ${r.conf.toFixed(2)}`] }),
      Text({ children: [r.kept ? '= kept' : '→ switched'], color: r.kept ? 'subtle' : 'claude' }),
    ]),
    ...(why ? [row(els, [Box({ width: LABEL }), Text({ children: [why], color: 'subtle', dimColor: true })])] : []),
  ]
}

function taskRows(els: Els, t: Snapshot, task: Task): RenderElement[] {
  const { Box, Text } = els
  const done = task.agents.filter(a => a.status !== 'running').length
  const status = task.status === 'running' ? `step ${task.steps}` : `${task.status} · ${fmtTime(task.seconds ?? 0)}`
  const head = row(els, [
    Box({
      width: LABEL,
      children: [Text({ children: [`● ${fmtFit(task.name, LABEL - 3)}`], bold: true, color: task.status === 'failed' ? 'error' : 'text' })],
    }),
    bar(els, `task-${task.id}`, t, barWidth(t), toneOf(task.status), null, accentOf(task.model)),
    Text({ children: [status], color: 'subtle' }),
    ...(task.agents.length > 0 ? [Text({ children: [`${done}/${task.agents.length} agents`] })] : []),
  ])
  const agents = task.agents.map(a => {
    const seconds = a.status === 'running' ? (t.now - a.startedAt) / 1000 : (a.seconds ?? 0)
    const family = a.model ? familyOf(a.model) : null
    const state = a.status === 'running' ? 'running' : a.status === 'done' ? 'Done' : 'failed'
    return Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ children: [`   └ ${fmtFit(a.name, 28)} ·`], color: 'subtle' }),
        Text({ children: [state], color: a.status === 'failed' ? 'error' : a.status === 'done' ? 'success' : family ? MODEL_TONE[family] : 'text' }),
        Text({ children: ['·'], color: 'subtle' }),
        Text({ children: [` ${family ?? a.model ?? '—'} `], color: family ? MODEL_TONE[family] : 'subtle', inverse: family !== null }),
        Text({ children: [`· ${fmtTime(seconds)}`], color: 'subtle' }),
      ],
    })
  })
  return [head, ...agents]
}

function meterRow(els: Els, t: Snapshot, glyph: string, name: string, detail: string, key: string, pct: number | null, accent: number): RenderElement {
  // No reading means an empty track, never a shimmer or an invented figure
  return row(els, [label(els, glyph, name), bar(els, key, t, barWidth(t), 'run', pct ?? 0, accent), els.Text({ children: [detail] })])
}

function listRow(els: Els, glyph: string, name: string, items: string[], empty: string, total: string): RenderElement {
  const { Text } = els
  return row(els, [
    label(els, glyph, name),
    ...(items.length > 0 ? items.map(s => Text({ children: [s] })) : [Text({ children: [empty], color: 'subtle' })]),
    Text({ children: [total], color: 'subtle' }),
  ])
}

// The band above the prompt. One row per fact the events expose; nothing is estimated.
export function drawBand(els: Els, t: Snapshot): RenderElement {
  const { Box, Text } = els
  const shown = [...t.tasks.filter(task => task.status === 'running'), ...t.tasks.filter(task => task.status !== 'running').slice(-1)]
  const extra = t.plugins.length - 5
  const ctx = t.usage?.context ?? null
  const five = t.usage?.rateLimits.find(r => r.kind === 'five_hour')
  const week = t.usage?.rateLimits.find(r => r.kind === 'seven_day')
  const calls = t.mcp.reduce((n, m) => n + m.calls, 0)

  return Box({
    flexDirection: 'column',
    children: [
      ...header(els, t),
      ...(t.route ? routeRows(els, t.route) : [row(els, [label(els, '⇄', 'Model route'), Text({ children: ['waiting for the first request'], color: 'subtle' })])]),
      ...shown.flatMap(task => taskRows(els, t, task)),
      listRow(els, '✦', 'Skills', t.skills.slice(-4).map(s => `${s.name} used ×${s.uses}`), 'none used yet', `${t.skills.length} used`),
      listRow(els, '◇', 'MCP', t.mcp.slice(-3).map(m => `${m.server} · ${m.tool} ×${m.calls}`), 'no calls yet', `${calls} calls`),
      listRow(els, '▣', 'Plugins', [...t.plugins.slice(-5), ...(extra > 0 ? [`+${extra}`] : [])], 'none seen', `${t.plugins.length} mods`),
      meterRow(els, t, '◆', 'Context', ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)} · ${fmtPct(ctx.percent)}` : '—', 'context', ctx?.percent ?? null, ACCENT.brand),
      ...(t.jev
        ? [meterRow(els, t, '◈', 'Jev · context', `${fmtTokens(t.jev.input)} / ${fmtTokens(JEV_WINDOW)} · ${fmtPct((t.jev.input / JEV_WINDOW) * 100)} · ${t.jev.calls} calls`, 'jev', (t.jev.input / JEV_WINDOW) * 100, ACCENT.brand)]
        : []),
      meterRow(els, t, '◷', 'Session · 5h', five ? `5h · ${fmtPct(five.percentUsed)} used` : 'no reading', 'session', five?.percentUsed ?? null, ACCENT.sonnet),
      meterRow(els, t, '◷', 'Weekly · 7d', week ? `7d · ${fmtPct(week.percentUsed)} used` : 'no reading', 'weekly', week?.percentUsed ?? null, ACCENT.opus),
    ],
  })
}

