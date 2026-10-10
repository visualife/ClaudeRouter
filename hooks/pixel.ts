// Raster cells: the crab crew and the bars. A mod cannot read the theme, so Raster colours are
// the design's fixed RGB; empty cells use the terminal's own default so light and dark both read.
export const DEFAULT = 0x01000000

// The design's accents: model chips, meters and the bars that follow them
export const ACCENT = {
  haiku: 0x55c99a,
  sonnet: 0xa79cf2,
  opus: 0xf0b84a,
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

// Dither ramp: sparse at the left, dense at the leading edge, like the design's fading dot field
const RAMP = ['⡀', '⡄', '⡆', '⡇', '⣿']
const TRACK: Cell = ['⠂', ACCENT.track]

function lighten(c: number): number {
  const ch = (s: number) => Math.min(255, (((c >> s) & 0xff) + 255) >> 1) << s
  return ch(16) | ch(8) | ch(0)
}

// One row of a bar in an accent colour. A known percent fills to it along the ramp; 'run' with
// none shimmers (a twinkling dithered field with a bright head sweeping through); 'done' and 'fail' are solid.
export function barCells(width: number, frame: number, tone: Tone, pct: number | null, accent: number): Cell[] {
  if (tone === 'fail') return Array.from({ length: width }, (): Cell => ['█', ACCENT.fail])
  if (tone === 'done') return Array.from({ length: width }, (): Cell => ['█', accent])
  if (pct !== null) {
    const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
    return Array.from({ length: width }, (_, x): Cell => {
      if (x >= filled) return TRACK
      const level = Math.min(RAMP.length - 1, Math.floor(((x + 1) / filled) * RAMP.length))
      return [RAMP[level] ?? '⣿', accent]
    })
  }
  const head = (frame % (width + 6)) - 3
  return Array.from({ length: width }, (_, x): Cell => {
    const d = x - head
    if (d >= 0 && d < 3) return ['⣿', lighten(accent)]
    const twinkle = (x * 7 + frame) % 5
    return [RAMP[twinkle < 2 ? 1 : twinkle < 4 ? 2 : 3] ?? '⡆', accent]
  })
}

// A Raster the timer repaints with $.ui.blit: a shimmering bar, or a running crab
export type Anim =
  | { key: string; kind: 'bar'; width: number; accent: number }
  | { key: string; kind: 'sprite'; role: Role }

export function animCells(a: Anim, frame: number): string {
  return a.kind === 'sprite' ? spriteCells(a.role, 'run', frame) : packCells([barCells(a.width, frame, 'run', null, a.accent)])
}
