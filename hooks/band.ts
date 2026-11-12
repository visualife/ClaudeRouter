import type { Elements, RenderElement } from 'claude-code'
import type { JevUse, McpUse, Route, SkillUse, Task, Usage } from '../types'
import { JEV_WINDOW } from './jev'
import { familyOf } from './route'
import { ACCENT, DEFAULT, type Anim, type Cell, type Role, type Tone, MINI_COLUMNS, MINI_ROWS, barLine, filledOf, miniCells, miniLine, packCells, pillRows, spriteCells, SPRITE_COLUMNS, SPRITE_ROWS } from './pixel'
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
function runs(els: Els, cells: Cell[], small = true): RenderElement {
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
    // caption: the small text size, used for the crab; bars pass small = false and keep the normal size
    out.push(els.Text({ children: [text], ...(small ? { size: 'caption' as const } : {}), ...(fg !== DEFAULT ? { color: hex(fg) } : {}), ...(bg !== undefined && bg !== DEFAULT ? { backgroundColor: hex(bg) } : {}) }))
    i = j
  }
  return els.Box({ flexDirection: 'row', children: out })
}

// A bar: one text line tall with a 4-row braille dot matrix inside it, as in the reference. A Raster in the terminal, Text runs on the
// desktop. It shows the value and never moves; a label becomes the capsule at the edge of the fill.
export function bar(els: Els, key: string, t: Snapshot, width: number, tone: Tone, pct: number | null, accent: number, label?: string): RenderElement {
  const line = barLine(width, tone, pct, accent)
  const cells = label ? (pillRows([line], label, accent, filledOf(width, pct))[0] ?? line) : line
  // One line tall on both surfaces: the Raster in the terminal, Text runs at the normal size on the desktop
  // A 1px black contour around the bar (a single-line border in the terminal)
  const inner = t.terminal ? els.Raster({ key, columns: width, rows: 1, cells: packCells([cells]) }) : runs(els, cells, false)
  return els.Box({ borderStyle: 'single', borderColor: '#000000', padding: 0, margin: 0, flexShrink: 0, children: [inner] })
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

// Compact layout: related facts share a row, so the whole band fits without scrolling and no row is mostly empty.
const HALF = (t: Snapshot) => Math.max(26, Math.floor((t.columns - 2) / 2))
const CELL_LABEL = 10

// A connector named by a UUID (claude.ai connectors) is shown by its first 8 characters
const serverName = (s: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? s.slice(0, 8) : fmtFit(s.replace(/^plugin:/, ''), 16))

// Half a row: a short label, a bar, the figure. No reading means an empty track, never a shimmer or an invented figure.
function meterCell(els: Els, t: Snapshot, glyph: string, name: string, detail: string, key: string, pct: number | null, accent: number): RenderElement {
  const width = HALF(t)
  const bw = Math.max(6, Math.min(14, width - CELL_LABEL - detail.length - 4))
  return els.Box({
    width,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 1,
    children: [
      els.Box({ width: CELL_LABEL, children: [els.Text({ children: [`${glyph} ${name}`], color: 'subtle' })] }),
      bar(els, key, t, bw, 'run', pct ?? 0, accent),
      els.Text({ children: [detail] }),
    ],
  })
}

function listCell(els: Els, t: Snapshot, glyph: string, name: string, items: string[], empty: string, total: string): RenderElement {
  const { Text } = els
  return els.Box({
    width: HALF(t),
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Text({ children: [`${glyph} ${name}`], color: 'subtle' }),
      ...(items.length > 0 ? items.map(s => Text({ children: [s] })) : [Text({ children: [empty], color: 'subtle' })]),
      Text({ children: [total], color: 'subtle' }),
    ],
  })
}

// Skills, MCP, plugins, context and plan usage: shared by the band and the pane. Seven rows became five.
export function factRows(els: Els, t: Snapshot): RenderElement[] {
  const extra = t.plugins.length - 2
  const ctx = t.usage?.context ?? null
  const five = t.usage?.rateLimits.find(r => r.kind === 'five_hour')
  const week = t.usage?.rateLimits.find(r => r.kind === 'seven_day')
  const calls = t.mcp.reduce((n, m) => n + m.calls, 0)
  // Two columns, four rows: Skills | Plugins, MCP | Keep warm, Context | Session, Weekly | Fable. Jev adds a fifth row only once it is used.
  return [
    row(els, [
      listCell(els, t, '✦', 'Skills', t.skills.slice(-1).map(s => `${fmtFit(s.name, 18)} ×${s.uses}`), 'none yet', `${t.skills.length} used`),
      listCell(els, t, '▣', 'Plugins', [...t.plugins.slice(-2).map(x => fmtFit(x, 14)), ...(extra > 0 ? [`+${extra}`] : [])], 'none', `${t.plugins.length} mods`),
    ]),
    row(els, [
      listCell(els, t, '◇', 'MCP', t.mcp.slice(-1).map(m => `${serverName(m.server)} · ${fmtFit(m.tool, 14)} ×${m.calls}`), 'no calls yet', `${calls} calls`),
      warmCell(els, t),
    ]),
    row(els, [
      meterCell(els, t, '◆', 'Context', ctx ? `${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.window)} ${fmtPct(ctx.percent)}` : '—', 'context', ctx?.percent ?? null, ACCENT.brand),
      meterCell(els, t, '◷', 'Session', five ? fmtPct(five.percentUsed) : '—', 'session', five?.percentUsed ?? null, ACCENT.sonnet),
    ]),
    row(els, [
      meterCell(els, t, '◷', 'Weekly', week ? fmtPct(week.percentUsed) : '—', 'weekly', week?.percentUsed ?? null, ACCENT.opus),
      fableCell(els, t),
    ]),
    ...(t.jev ? [row(els, [jevCell(els, t.jev)])] : []),
  ]
}

// Fable usage. The engine reports no Fable window of its own today (only five_hour, seven_day and a gateway spend
// limit), so this shows what is measured here: the share of this session's tokens that ran on Fable. If a window
// whose kind names Fable ever arrives, that reading is shown instead.
function fableCell(els: Els, t: Snapshot): RenderElement {
  const limit = t.usage?.rateLimits.find(r => /fable/i.test(r.kind))
  if (limit) return meterCell(els, t, '✧', 'Fable', fmtPct(limit.percentUsed), 'fable', limit.percentUsed, ACCENT.fable)
  const on = (m: string | null) => m !== null && familyOf(m) === 'fable'
  const used = t.tasks.reduce((n, task) => n + (on(task.model) ? (task.tokens ?? 0) : 0) + task.agents.reduce((k, a) => k + (on(a.model) ? a.tokens : 0), 0), 0)
  const total = t.totals.tokens
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : null
  return meterCell(els, t, '✧', 'Fable', pct === null ? '—' : `${fmtPct(pct)} of session`, 'fable', pct, ACCENT.fable)
}

// Jev's last call against its own window, as text: no bar, so the row stays short
function jevCell(els: Els, jev: JevUse): RenderElement {
  return els.Text({ children: [`◈ Jev ${fmtTokens(jev.input)}/${fmtTokens(JEV_WINDOW)} · ${jev.calls} calls`], color: 'subtle' })
}

// The keep-warm clock: time left in the window, and the countdown to the next cache ping
function warmCell(els: Els, t: Snapshot): RenderElement {
  const w = t.warm
  if (!w) return els.Text({ children: ['♨ Keep warm off · /cr-warm 2h'], color: 'subtle' })
  const left = `${fmtTime(Math.max(0, w.until - t.now) / 1000)} left`
  const ping =
    w.pingAt === null ? 'ping after your next request'
    : w.pingAt <= t.now ? 'ping due when idle'
    : `ping in ${fmtTime((w.pingAt - t.now) / 1000)}`
  return els.Text({ children: [`♨ Keep warm on · ${left} · ${ping}`], color: 'success' })
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
  // The reference crab: a Raster in the terminal, one line of braille dots on the desktop
  const step = running && Math.floor(t.frame / 4) % 2 === 1
  const crabEl = t.terminal
    ? els.Raster({ key: 'task-crab', columns: MINI_COLUMNS, rows: MINI_ROWS, cells: miniCells(step) })
    : runs(els, miniLine(step), false)
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
        bar(els, `taskbar-${task.id}`, t, width, toneOf(task.status), pct, accent, label),
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
      row(els, [Text({ children: ['ClaudeRouter pane: /cr'], color: 'subtle', dimColor: true })]),
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

