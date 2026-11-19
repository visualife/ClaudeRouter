import { expect, test } from 'claude-code/testing'

import { ACCENT, BAR_ROWS, barRows, filledOf, miniLine, type Cell } from '../hooks/pixel'

// Brightness of a colour: the sum of its channels
const lum = (c: number | undefined) => (((c ?? 0) >> 16) & 0xff) + (((c ?? 0) >> 8) & 0xff) + ((c ?? 0) & 0xff)
const glyphs = (g: Cell[][]) => g.map(r => r.map(c => c[0]).join(''))
// The cells that hold a pixel: a space is empty
const dots = (g: Cell[][], from: number, to: number) => g.flatMap(r => r.slice(from, to)).filter(c => c[0] !== ' ')
const avg = (cells: Cell[]) => cells.reduce((n, c) => n + lum(c[1]), 0) / Math.max(1, cells.length)

test('a bar is a few rows of small square pixels: the right size, a sparse field, never solid', () => {
  for (const tone of ['run', 'done', 'fail'] as const) {
    for (const pct of [null, 0, 37, 50, 100]) {
      const g = barRows(30, BAR_ROWS, tone, pct, ACCENT.sonnet)
      expect(g.length).toBe(BAR_ROWS)
      expect(g.every(r => r.length === 30)).toBe(true)
      const density = dots(g, 0, 30).length / (BAR_ROWS * 30)
      expect(density).toBeGreaterThan(0.3)
      expect(density).toBeLessThan(0.92)
    }
  }
  // more than one line of dots, like the reference
  expect(BAR_ROWS).toBeGreaterThanOrEqual(2)
})

test('the fill reveals one fixed texture: the track ahead has the same pixels, only dimmer', () => {
  const half = barRows(20, 3, 'run', 50, ACCENT.sonnet)
  const full = barRows(20, 3, 'run', 100, ACCENT.sonnet)
  const none = barRows(20, 3, 'run', null, ACCENT.sonnet)
  // the same cells are empty whatever the value (a lit cell may be ▀ or █ depending on its shade)
  const mask = (g: Cell[][]) => glyphs(g).map(r => r.replace(/[^ ]/g, 'x'))
  expect(mask(half)).toEqual(mask(none))
  expect(mask(full)).toEqual(mask(none))
  // every filled pixel is brighter than every pixel still ahead
  const fill = dots(half, 0, 10).map(c => lum(c[1]))
  const ahead = dots(half, 10, 20).map(c => lum(c[1]))
  expect(Math.min(...fill)).toBeGreaterThan(Math.max(...ahead))
})

test('opacity is eased, not linear: the fill brightens slowly then fast toward its edge, and the track ahead fades out', () => {
  const g = barRows(40, 3, 'run', 100, ACCENT.sonnet)
  const first = avg(dots(g, 0, 6))
  const mid = avg(dots(g, 17, 23))
  const last = avg(dots(g, 34, 40))
  expect(last).toBeGreaterThan(first)
  // a linear ramp would put the middle at the average of the two ends; an eased one sits well below it
  expect(mid).toBeLessThan((first + last) / 2)
  const ahead = barRows(40, 3, 'run', 10, ACCENT.sonnet)
  expect(avg(dots(ahead, 5, 14))).toBeGreaterThan(avg(dots(ahead, 31, 40)))
})

test('nothing moves, and the fill is the value', () => {
  expect(barRows(30, 2, 'run', 40, ACCENT.sonnet)).toEqual(barRows(30, 2, 'run', 40, ACCENT.sonnet))
  expect(filledOf(30, null)).toBe(0)
  expect(filledOf(30, 0)).toBe(0)
  expect(filledOf(30, 50)).toBe(15)
  expect(filledOf(30, 100)).toBe(30)
  expect(filledOf(30, 250)).toBe(30)
  expect(filledOf(20, 25)).toBe(5)
})

test('a failed bar is red', () => {
  const g = barRows(20, 2, 'fail', 100, ACCENT.sonnet)
  const red = (c: Cell) => ((c[1] >> 16) & 0xff) > ((c[1] >> 8) & 0xff) && ((c[1] >> 16) & 0xff) > (c[1] & 0xff)
  expect(dots(g, 0, 20).every(red)).toBe(true)
})

test('the capsule is full height, rides the edge of the fill and stays inside the bar', () => {
  const at = (pct: number | null) => {
    const g = barRows(40, 3, 'run', pct, ACCENT.sonnet, 'Tasks 2/4')
    // the label is on the middle row; the rows above and below are the same capsule, blank
    expect(g.length).toBe(3)
    return glyphs(g)[1]?.indexOf(' Tasks 2/4 ') ?? -1
  }
  expect(at(null)).toBe(0)
  expect(at(25)).toBe(10)
  expect(at(50)).toBe(20)
  // near the end it is held inside the bar
  expect(at(100)).toBe(40 - ' Tasks 2/4 '.length)
  // a bar too narrow for the label is left alone
  expect(glyphs(barRows(8, 3, 'run', 50, ACCENT.sonnet, 'Tasks 2/4')).join('')).not.toContain('Tasks')
})

test("the desktop crab is one line of five braille characters, and its legs step", () => {
  const still = miniLine(false).map(c => c[0]).join("")
  expect([...still].length).toBe(5)
  expect([...still].every(ch => ch >= "⠀" && ch <= "⣿")).toBe(true)
  // arms: the second dot row is lit in the first and last column
  expect(((still.codePointAt(0) ?? 0) - 0x2800) & 0x02).toBe(0x02)
  expect(miniLine(true).map(c => c[0]).join("")).not.toBe(still)
})
