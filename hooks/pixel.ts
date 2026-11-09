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
  track: 0x403f48,
}

// One cell: a character, its foreground colour and its background (the terminal's by default)
export type Cell = [string, number, number?]

// Pack rows of cells into the base64 string a Raster takes: per cell the code point, foreground, background
export function packCells(rows: Cell[][]): string {
  const words = Uint32Array.from(rows.flat().flatMap(([char, fg, bg]) => [char.codePointAt(0) ?? 32, fg, bg ?? DEFAULT]))
  // toBase64 is in the mods runtime but not in the es2023 lib the types check against
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

// The crab, two frames (arm wave and step). Matches the reference crab (the Savvy Progress bar): eyes in the
// head, side arms, no mouth, four short legs that alternate.
const BA = ['................', '................', '................', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBB..', '..BBBEBBBBEBBB..', 'AABBBEBBBBEBBBAA', 'AABBBBBBBBBBBBAA', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBB..', '...F.F....F.F...', '...F.F....F.F...']
const BB = ['................', '................', '................', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBBAA', '..BBBEBBBBEBBBAA', 'AABBBEBBBBEBBB..', 'AABBBBBBBBBBBB..', '..BBBBBBBBBBBB..', '..BBBBBBBBBBBB..', '...F.F....F.F...', '..F.F......F.F..']
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
  return packCells(pixelCells(pixels(role, mode === 'run' && Math.floor(frame / 4) % 2 === 1)))
}

// The small crab for the task bar: 11 x 4 pixels, exactly 2 terminal rows, so nothing is cut or padded out of the row.
// The reference's shape: eyes, side arms, body, four legs.
const MINI_A = ['..BEBBBEB..', 'ABBBBBBBBBA', '..BBBBBBB..', '..B.B.B.B..']
const MINI_B = ['..BEBBBEB..', 'ABBBBBBBBBA', '..BBBBBBB..', '.B.B.B.B.B.']
export const MINI_COLUMNS = 11
export const MINI_ROWS = 2
export function miniRows(step: boolean): Cell[][] {
  const pal: Record<string, number> = { B: 0xe07a5f, A: 0xd06e54, E: 0x1a1214 }
  const art = (step ? MINI_B : MINI_A).map(r => [...r].map((ch): number | null => (ch === '.' ? null : (pal[ch] ?? null))))
  return pixelCells(art)
}
export const miniCells = (step: boolean): string => packCells(miniRows(step))

function pixelCells(px: (number | null)[][]): Cell[][] {
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
  return rows
}

export type Tone = 'run' | 'done' | 'fail'

// The bar is one fixed dot-matrix texture, like the reference: a few rows of small square pixels (two per terminal
// row, as half blocks) lit at random but stable positions. The filled part shows it in the accent, the part still
// ahead shows the same pattern very dim, so the fill reads as the texture being revealed. Nothing moves.
const GHOST = ACCENT.track
export const BAR_ROWS = 2

// A stable 0..1 value for a position and a seed
function hash(x: number, seed: number): number {
  let h = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(seed + 7, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

// The accent scaled toward black
function shade(c: number, f: number): number {
  const ch = (s: number) => Math.round(((c >> s) & 0xff) * f) << s
  return ch(16) | ch(8) | ch(0)
}

// Opacity is eased, never linear, and snapped to a few steps so runs of one colour stay long (the desktop draws a
// Text per run). The fill is dim at its tail and brightens toward the leading edge on a power curve, each pixel a
// little different. The track ahead is far dimmer than any filled pixel and fades out on a smoothstep.
const smooth = (t: number) => t * t * (3 - 2 * t)
const snap = (f: number) => Math.round(f * 8) / 8
function fillLevel(x: number, y: number, filled: number): number {
  const t = (x + 1) / Math.max(1, filled)
  return Math.min(1, (0.55 + 0.45 * Math.pow(t, 2.4)) * (0.88 + 0.24 * hash(x * 13 + y, 3)))
}
function ghostLevel(x: number, filled: number, width: number): number {
  const u = (x - filled + 1) / Math.max(1, width - filled)
  return 0.42 - 0.25 * smooth(Math.min(1, Math.max(0, u)))
}

// How many of width cells a percent fills
export function filledOf(width: number, pct: number | null): number {
  return pct === null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
}

const lit = (x: number, y: number) => hash(x * 41 + y * 17, 11) < 0.42

// A bar as `rows` terminal rows of cells (2 pixels each). The tone only colours the fill (a failed one is red); how
// much is filled is the value. No reading yet: all ghost. A label becomes the capsule at the edge of the fill.
export function barRows(width: number, rows: number, tone: Tone, pct: number | null, accent: number, label?: string): Cell[][] {
  const color = tone === 'fail' ? ACCENT.fail : accent
  const filled = filledOf(width, pct)
  const px = Array.from({ length: rows * 2 }, (_, y) =>
    Array.from({ length: width }, (_, x): number | null => {
      if (!lit(x, y)) return null
      return x >= filled ? shade(GHOST, snap(ghostLevel(x, filled, width))) : shade(color, snap(fillLevel(x, y, filled)))
    }),
  )
  const grid = pixelCells(px)
  return label ? pillRows(grid, label, accent, filled) : grid
}

// The "Tasks 2/4" capsule: dark text on the accent, full height, riding the edge of the fill and held inside the bar
function pillRows(grid: Cell[][], text: string, accent: number, at: number): Cell[][] {
  const label = ` ${text} `
  const width = grid[0]?.length ?? 0
  if (label.length + 2 > width) return grid
  const start = Math.min(Math.max(0, at), width - label.length)
  const mid = Math.floor(grid.length / 2)
  return grid.map((cells, r) => cells.map((c, i): Cell => (i >= start && i < start + label.length ? [r === mid ? (label[i - start] ?? ' ') : ' ', 0x14121a, accent] : c)))
}

// A Raster the timer repaints with $.ui.blit: a running crab (bars are static and never repainted)
export type Anim = { key: string; kind: 'sprite'; role: Role } | { key: string; kind: 'mini' }

export function animCells(a: Anim, frame: number): string {
  return a.kind === 'sprite' ? spriteCells(a.role, 'run', frame) : miniCells(Math.floor(frame / 4) % 2 === 1)
}
