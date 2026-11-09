// Raster cells: the crab crew and the bars. A mod cannot read the theme, so Raster colours are
// the design's fixed RGB; empty cells use the terminal's own default so light and dark both read.
export const DEFAULT = 0x01000000

// The design's accents: model chips, meters and the bars that follow them
export const ACCENT = {
  haiku: 0x55c99a,
  sonnet: 0xa79cf2,
  opus: 0xf0b84a,
  fable: 0x6cb6ff,
  brand: 0xe8835f,
  fail: 0xd9534f,
  track: 0x55535b,
}

// One cell: a character, its foreground colour and its background (the terminal's by default)
export type Cell = [string, number, number?]

// Pack rows of cells into the base64 string a Raster takes: per cell the code point, foreground, background
export function packCells(rows: Cell[][]): string {
  const words = Uint32Array.from(rows.flat().flatMap(([char, fg, bg]) => [char.codePointAt(0) ?? 32, fg, bg ?? DEFAULT]))
  // toBase64 is in the mods runtime but not in the es2023 lib the types check against
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

// The crab, two frames (arm wave and step), from the design's BA / BB maps
const BA = ['................', '................', '................', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBB..', '..BBBEBBBBEBBB..', 'AABBBEBBBBEBBBAA', 'AABBBBBBBBBBBBAA', '..BRRBBBBBBRRB..', '..BBBBBBBBBBBB..', '...FF......FF...', '...FF......FF...']
const BB = ['................', '................', '................', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBBAA', '..BBBEBBBBEBBBAA', 'AABBBEBBBBEBBB..', 'AABBBBBBBBBBBB..', '..BRRBBBBBBRRB..', '..BBBBBBBBBBBB..', '...FF......FF...', '....FF....FF....']
const PAL: Record<string, number> = {
  A: 0xd06e54, R: 0xd9706f, F: 0xb4573f, B: 0xe07a5f, E: 0x1a1214, W: 0xece9e4, K: 0x2b2a30,
  G: 0xa3a1a9, T: 0xb08a5a, P: 0xd9d6dd, N: 0x2f3a5c, Y: 0xe9c84a, Q: 0xa6d8ec,
}

type Part = [row: number, col: number, px: string]
type RoleArt = { c: Record<string, number>; hat: Part[]; prop: Part[] }

// Each role wears a hat and holds a tool: router headset + signpost, scout cap + flag,
// builder hard hat + wrench, researcher bucket hat + magnifier, planner captain's cap + clipboard
const ROLES = {
  router: { c: { X: ACCENT.brand }, hat: [[0, 5, 'KKKKKK'], [1, 4, 'K......K'], [2, 3, 'XX......XX'], [3, 3, 'X........X']], prop: [[-3, 16, 'XXX'], [-2, 16, 'XXXX'], [-1, 16, 'XXX'], [0, 17, 'T'], [1, 17, 'T'], [2, 17, 'T']] },
  scout: { c: { H: 0x2fa374, V: 0x1f6b4d }, hat: [[0, 5, 'HHHHHH'], [1, 4, 'HHHWWHHH'], [2, 4, 'HHHHHHHHV']], prop: [[-4, 16, 'PKWK'], [-3, 16, 'PWKW'], [-2, 16, 'PKWK'], [-1, 16, 'P'], [0, 16, 'P'], [1, 16, 'P']] },
  builder: { c: { H: 0xe9c84a, h: 0xb88a2a }, hat: [[0, 6, 'HHHH'], [1, 4, 'HHHhHHHH'], [2, 3, 'hhhhhhhhhh']], prop: [[-3, 16, 'G.G'], [-2, 16, 'GGG'], [-1, 17, 'G'], [0, 17, 'G'], [1, 17, 'G']] },
  researcher: { c: { H: 0x7a5236, h: 0xa8744c }, hat: [[0, 5, 'HhHHhH'], [1, 4, 'HHHHHHHH'], [2, 3, 'HHHHHHHHHH']], prop: [[-4, 17, 'GG'], [-3, 16, 'GQQG'], [-2, 16, 'GQQG'], [-1, 17, 'GG'], [0, 16, 'T'], [1, 15, 'T']] },
  planner: { c: {}, hat: [[0, 5, 'WWWWWW'], [1, 4, 'WWWYYWWW'], [2, 4, 'NNNNNNNN']], prop: [[-3, 17, 'T'], [-2, 16, 'WWW'], [-1, 16, 'WKW'], [0, 16, 'WWW'], [1, 16, 'WKW']] },
} satisfies Record<string, RoleArt>

export type Role = keyof typeof ROLES
export type Mode = 'run' | 'still'

// The used part of the design's grid: body rows -4 (the tallest prop) to 11, columns 0 to 19
const TOP = -4
const PX_ROWS = 16
export const SPRITE_COLUMNS = 20
export const SPRITE_ROWS = PX_ROWS / 2

function pixels(role: Role, step: boolean): (number | null)[][] {
  const art: RoleArt = ROLES[role]
  const pal: Record<string, number> = { ...PAL, ...art.c }
  const grid = Array.from({ length: PX_ROWS }, () => Array<number | null>(SPRITE_COLUMNS).fill(null))
  const put = (r: number, c: number, s: string) =>
    [...s].forEach((ch, i) => {
      const row = grid[r - TOP]
      if (ch !== '.' && row && c + i < SPRITE_COLUMNS) row[c + i] = pal[ch] ?? null
    })
  ;(step ? BB : BA).forEach((row, r) => put(r, 0, row))
  art.hat.forEach(([r, c, s]) => put(r, c, s))
  // The tool bobs with the step, as the design's two frames do
  art.prop.forEach(([r, c, s]) => put(r + (step ? 0 : 1), c, s))
  return grid
}

// Two pixel rows per terminal row: '▀' holds the top pixel in its foreground and the bottom in its background
export function spriteCells(role: Role, mode: Mode, frame: number): string {
  const px = pixels(role, mode === 'run' && Math.floor(frame / 4) % 2 === 1)
  const rows: Cell[][] = []
  for (let y = 0; y + 1 < px.length; y += 2) {
    const top = px[y] ?? []
    const bottom = px[y + 1] ?? []
    rows.push(
      top.map((t, x): Cell => {
        const b = bottom[x] ?? null
        if (t === null && b === null) return [' ', DEFAULT]
        if (t === b) return ['█', t ?? DEFAULT]
        if (b === null) return ['▀', t ?? DEFAULT]
        if (t === null) return ['▄', b]
        return ['▀', t, b]
      }),
    )
  }
  return packCells(rows)
}

export type Tone = 'run' | 'done' | 'fail'

// Bars are a field of scattered braille dots, never a solid fill: sparse at the left, thicker toward the
// leading edge, a few brighter sparks. A full cell (⣿ or █) is never drawn.
const SPARK1 = ['⠁', '⠂', '⠄', '⡀', '⠈', '⠐', '⠠', '⢀']
const SPARK2 = ['⠅', '⠊', '⠑', '⠢', '⡈', '⢐', '⠌', '⡐']
const SPARK3 = ['⠕', '⠪', '⡢', '⢕', '⠵', '⡪']
const TRACK: Cell = ['⠂', ACCENT.track]

function lighten(c: number): number {
  const ch = (s: number) => Math.min(255, (((c >> s) & 0xff) + 255) >> 1) << s
  return ch(16) | ch(8) | ch(0)
}

// A stable 0..1 value for a column and a seed: the same dots every draw, until the seed moves
function hash(x: number, seed: number): number {
  let h = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(seed + 7, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

// One sparkle cell: density d (0 sparse, 1 thick) picks how many dots, the hash which ones
function sparkle(x: number, seed: number, d: number, accent: number): Cell {
  const r = hash(x, seed)
  const level = d + (r - 0.5) * 0.4
  const set = level < 0.4 ? SPARK1 : level < 0.75 ? SPARK2 : SPARK3
  const glyph = set[Math.floor(hash(x, seed + 1) * set.length)] ?? '⠂'
  return [glyph, r > 0.94 ? lighten(accent) : accent]
}

// One row of a bar in an accent colour. A known percent fills to it, thickening toward the edge; 'run' with
// none shimmers (twinkling dots with a brighter head sweeping through); 'done' and 'fail' are a still sparkle field.
// Static: the bars show the real value, and nothing moves. With no reading yet, a faint field and no fill.
export function barCells(width: number, _frame: number, tone: Tone, pct: number | null, accent: number): Cell[] {
  // The tone only colours the fill (a failed one is red); how much is filled is always the value
  const color = tone === 'fail' ? ACCENT.fail : accent
  if (pct === null) return Array.from({ length: width }, (): Cell => TRACK)
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return Array.from({ length: width }, (_, x): Cell => (x >= filled ? TRACK : sparkle(x, 0, 0.2 + 0.7 * ((x + 1) / filled), color)))
}

// A label drawn over the middle of a bar, like the "Tasks 2/4" pill: dark text on the accent
export function withPill(cells: Cell[], text: string, accent: number): Cell[] {
  const label = ` ${text} `
  if (label.length + 2 > cells.length) return cells
  const start = Math.floor((cells.length - label.length) / 2)
  return cells.map((c, i): Cell => (i >= start && i < start + label.length ? [label[i - start] ?? ' ', 0x14121a, accent] : c))
}

// A Raster the timer repaints with $.ui.blit: a shimmering bar (with its pill, if it has one), or a running crab
export type Anim =
  | { key: string; kind: 'bar'; width: number; accent: number; label?: string }
  | { key: string; kind: 'sprite'; role: Role }

export function animCells(a: Anim, frame: number): string {
  if (a.kind === 'sprite') return spriteCells(a.role, 'run', frame)
  const cells = barCells(a.width, frame, 'run', null, a.accent)
  return packCells([a.label ? withPill(cells, a.label, a.accent) : cells])
}

// A one-row crab for the task bar: claws up, brand colour
export const MINI_CRAB: Cell[] = [['▝', ACCENT.brand], ['▟', ACCENT.brand], ['█', ACCENT.brand], ['▙', ACCENT.brand], ['▘', ACCENT.brand]]
