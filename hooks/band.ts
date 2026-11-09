import type { Elements, RenderElement } from 'claude-code'
import type { JevUse, McpUse, Route, SkillUse, Task, Usage } from '../types'
import { JEV_WINDOW } from './jev'
import { familyOf } from './route'
import { ACCENT, BAR_ROWS, DEFAULT, type Anim, type Cell, type Role, type Tone, MINI_COLUMNS, MINI_ROWS, barRows, miniCells, miniRows, packCells, spriteCells, SPRITE_COLUMNS, SPRITE_ROWS } from './pixel'
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
  // Keep-warm window: when it ends and when the next ping is due (null until the first request); null while off
  warm: { until: number; pingAt: number | null } | null
  frame: number
  terminal: boolean
  columns: number
  rows: number
  anim: Anim[]
}

// Text uses theme keys so light and dark both read; Rasters use the design's accents
export const MODEL_TONE = { haiku: 'success', sonnet: 'suggestion', opus: 'warning', fable: 'claude' } as const
const EFFORT_LEVEL = { low: 1, medium: 2, high: 3, xhigh: 4 } as const
const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
const LABEL = 16
// Jev's own colour: pink, so it never reads as the orange of ClaudeRouter or Fable
const JEV_PINK = '#f472b6'
// The crew needs this many rows above the band's own before it is drawn
const CREW_MIN_ROWS = 22

export function accentOf(model: string | null): number {
  const family = model ? familyOf(model) : null
  return family ? ACCENT[family] : ACCENT.brand
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

// One terminal row of cells as Text runs, one Text per stretch of cells sharing their colours: the desktop has no
// Raster, so its pixels are half-block characters with a foreground and a background colour
function runs(els: Els, cells: Cell[]): RenderElement {
  const out: RenderElement[] = []
  let i = 0
  while (i < cells.length) {
    const fg = cells[i]?.[1] ?? DEFAULT
    const bg = cells[i]?.[2]
    let text = ''
    let j = i
    while (j < cells.length && cells[j]?.[1] === fg && cells[j]?.[2] === bg) {
      text += cells[j]?.[0] ?? ' '
      j += 1
    }
    out.push(els.Text({ children: [text], ...(fg !== DEFAULT ? { color: hex(fg) } : {}), ...(bg !== undefined && bg !== DEFAULT ? { backgroundColor: hex(bg) } : {}) }))
    i = j
  }
  return els.Box({ flexDirection: 'row', children: out })
}

function block(els: Els, rows: Cell[][]): RenderElement {
  return els.Box({ flexDirection: 'column', children: rows.map(r => runs(els, r)) })
}

// A bar: several rows of small square pixels, as in the reference. A Raster in the terminal, Text runs on the
// desktop. It shows the value and never moves; a label becomes the capsule at the edge of the fill.
export function bar(els: Els, key: string, t: Snapshot, width: number, tone: Tone, pct: number | null, accent: number, label?: string, rows = BAR_ROWS): RenderElement {
  const grid = barRows(width, rows, tone, pct, accent, label)
  return t.terminal ? els.Raster({ key, columns: width, rows, cells: packCells(grid) }) : block(els, grid)
}

// How far a task is, from what is measured: finished subagents over all of them; a finished task is 100%;
// a running one with no subagents has no reading yet, so its bar stays an empty track
export function taskPct(task: Task): number | null {
  if (task.status !== 'running') return 100
  return task.agents.length > 0 ? (task.agents.filter(a => a.status !== 'running').length / task.agents.length) * 100 : null
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
  return els.Box({ flexDirection: 'row', alignItems: 'center', columnGap: 2, children })
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
  chips.push(Text({ children: [' jev '], color: JEV_PINK, bold: r.by === 'jev', inverse: r.by === 'jev', dimColor: r.by !== 'jev' }))
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
    bar(els, `task-${task.id}`, t, barWidth(t), toneOf(task.status), taskPct(task), accentOf(task.model)),
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

// Skills, MCP, plugins, context and plan usage: shared by the band and the pane
export function factRows(els: Els, t: Snapshot): RenderElement[] {
  const extra = t.plugins.length - 5
  const ctx = t.usage?.context ?? null
  const five = t.usage?.rateLimits.find(r => r.kind === 'five_hour')
  const week = t.usage?.rateLimits.find(r => r.kind === 'seven_day')
  const calls = t.mcp.reduce((n, m) => n + m.calls, 0)
  return [
    listRow(els, '✦', 'Skills', t.skills.slice(-4).map(s => `${s.name} used ×${s.uses}`), 'none used yet', `${t.skills.length} used`),
    listRow(els, '◇', 'MCP', t.mcp.slice(-3).map(m => `${m.server} · ${m.tool} ×${m.calls}`), 'no calls yet', `${calls} calls`),
    listRow(els, '▣', 'Plugins', [...t.plugins.slice(-5), ...(extra > 0 ? [`+${extra}`] : [])], 'none seen', `${t.plugins.length} mods`),
    meterRow(els, t, '◆', 'Context', ctx ? `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)} · ${fmtPct(ctx.percent)}` : '—', 'context', ctx?.percent ?? null, ACCENT.brand),
    ...(t.jev
      ? [meterRow(els, t, '◈', 'Jev · context', `${fmtTokens(t.jev.input)} / ${fmtTokens(JEV_WINDOW)} · ${fmtPct((t.jev.input / JEV_WINDOW) * 100)} · ${t.jev.calls} calls`, 'jev', (t.jev.input / JEV_WINDOW) * 100, ACCENT.brand)]
      : []),
    meterRow(els, t, '◷', 'Session · 5h', five ? `5h · ${fmtPct(five.percentUsed)} used` : 'no reading', 'session', five?.percentUsed ?? null, ACCENT.sonnet),
    meterRow(els, t, '◷', 'Weekly · 7d', week ? `7d · ${fmtPct(week.percentUsed)} used` : 'no reading', 'weekly', week?.percentUsed ?? null, ACCENT.opus),
    warmRow(els, t),
  ]
}

// The keep-warm clock: time left in the window, and the countdown to the next cache ping
function warmRow(els: Els, t: Snapshot): RenderElement {
  const w = t.warm
  if (!w) return row(els, [label(els, '♨', 'Keep warm'), els.Text({ children: ['off · /clauderouter warm 2h'], color: 'subtle' })])
  const left = `${fmtTime(Math.max(0, w.until - t.now) / 1000)} left`
  const ping =
    w.pingAt === null ? 'first ping 50 min after your next request'
    : w.pingAt <= t.now ? 'ping due when idle'
    : `next ping in ${fmtTime((w.pingAt - t.now) / 1000)}`
  return row(els, [label(els, '♨', 'Keep warm'), els.Text({ children: [`on · ${left} · ${ping}`], color: 'success' })])
}

// The task bar: ● name, a sparkle bar with a "Tasks done/total" pill, the percent, a crab and the agent count.
// Shows the running task, else the last one; nothing before the first prompt.
export function taskBar(els: Els, t: Snapshot): RenderElement[] {
  const { Box, Text } = els
  const task = t.tasks.filter(x => x.status === 'running').at(-1) ?? t.tasks.at(-1)
  if (!task) return []
  const total = task.agents.length
  const done = task.agents.filter(a => a.status !== 'running').length
  const pct = taskPct(task)
  const label = total > 0 ? `Tasks ${done}/${total}` : task.status === 'running' ? `step ${task.steps}` : 'done'
  const accent = accentOf(task.model)
  const width = Math.max(12, Math.min(40, t.columns - 52))
  const running = task.status === 'running'
  if (t.terminal && running) t.anim.push({ key: 'task-crab', kind: 'mini' })
  // The reference crab: a Raster in the terminal, the same pixels as half-block Text runs on the desktop
  const step = running && Math.floor(t.frame / 4) % 2 === 1
  const crabEl = t.terminal
    ? els.Raster({ key: 'task-crab', columns: MINI_COLUMNS, rows: MINI_ROWS, cells: miniCells(step) })
    : block(els, miniRows(step))
  return [
    Box({
      flexDirection: 'row',
      alignItems: 'center',
      columnGap: 2,
      children: [
        Box({
          width: 20,
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['●'], color: MODEL_TONE[familyOf(task.model ?? '') ?? 'sonnet'] }), Text({ children: [fmtFit(task.name, 17)], bold: true })],
        }),
        bar(els, `taskbar-${task.id}`, t, width, toneOf(task.status), pct, accent, label, BAR_ROWS + 1),
        Text({ children: [pct === null ? '…' : fmtPct(pct)], color: 'subtle' }),
        crabEl,
        Text({ children: [`×${Math.max(1, total)}`], bold: true }),
      ],
    }),
  ]
}

// The strip above the prompt: only the model route. The full dashboard lives in the ClaudeRouter pane, which the person can drag.
export function drawStrip(els: Els, t: Snapshot): RenderElement {
  const { Box, Text } = els
  return Box({
    flexDirection: 'column',
    children: [
      ...taskBar(els, t),
      ...(t.route ? routeRows(els, t.route) : [row(els, [label(els, '⇄', 'Model route'), Text({ children: ['waiting for the first request'], color: 'subtle' })])]),
      row(els, [Text({ children: ['ClaudeRouter pane: /clauderouter'], color: 'subtle', dimColor: true })]),
    ],
  })
}

// The band above the prompt. One row per fact the events expose; nothing is estimated.
export function drawBand(els: Els, t: Snapshot): RenderElement {
  const { Box, Text } = els
  const shown = [...t.tasks.filter(task => task.status === 'running'), ...t.tasks.filter(task => task.status !== 'running').slice(-1)]

  return Box({
    flexDirection: 'column',
    children: [
      ...header(els, t),
      ...(t.route ? routeRows(els, t.route) : [row(els, [label(els, '⇄', 'Model route'), Text({ children: ['waiting for the first request'], color: 'subtle' })])]),
      ...shown.flatMap(task => taskRows(els, t, task)),
      ...factRows(els, t),
    ],
  })
}

