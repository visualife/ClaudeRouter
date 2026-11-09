import { expect, test } from 'claude-code/testing'

import { ACCENT, barCells, withPill } from '../hooks/pixel'

const SOLID = /[█⣿]/

test('bars are sparkle dots: no tone, percent or frame draws a solid cell', () => {
  for (const tone of ['run', 'done', 'fail'] as const) {
    for (const pct of [null, 0, 37, 50, 100]) {
      for (const frame of [0, 1, 7, 99]) {
        const text = barCells(30, frame, tone, pct, ACCENT.sonnet).map(c => c[0]).join('')
        expect(SOLID.test(text)).toBe(false)
        expect(text.length).toBe(30)
      }
    }
  }
})

test('a known percent leaves the rest of the track faint, and the dots thicken toward the edge', () => {
  const cells = barCells(20, 0, 'run', 50, ACCENT.sonnet)
  expect(cells.slice(10).every(c => c[1] === ACCENT.track)).toBe(true)
  expect(cells.slice(0, 10).every(c => c[1] !== ACCENT.track)).toBe(true)
  const dots = (c: string) => (c.codePointAt(0) ?? 0x2800) - 0x2800
  const count = (n: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter(b => n & (1 << b)).length
  const left = cells.slice(0, 4).reduce((n, c) => n + count(dots(c[0])), 0)
  const right = cells.slice(6, 10).reduce((n, c) => n + count(dots(c[0])), 0)
  expect(right).toBeGreaterThan(left)
})

test('nothing moves: a bar is the same on every frame, and the fill is the value', () => {
  const at = (pct: number | null, frame: number) => barCells(30, frame, 'run', pct, ACCENT.sonnet).map(c => c[0]).join('')
  expect(at(40, 0)).toBe(at(40, 8))
  expect(at(null, 0)).toBe(at(null, 8))
  // no reading: an empty track; a reading fills that share
  const lit = (pct: number | null) => barCells(30, 0, 'run', pct, ACCENT.sonnet).filter(c => c[1] !== ACCENT.track).length
  expect(lit(null)).toBe(0)
  expect(lit(0)).toBe(0)
  expect(lit(50)).toBe(15)
  expect(lit(100)).toBe(30)
})

test('a finished or failed bar still shows its value; failed is red', () => {
  const done = barCells(20, 0, 'done', 25, ACCENT.sonnet)
  expect(done.filter(c => c[1] !== ACCENT.track).length).toBe(5)
  const fail = barCells(20, 0, 'fail', 100, ACCENT.sonnet)
  expect(fail.every(c => c[1] === ACCENT.fail || c[1] !== ACCENT.sonnet)).toBe(true)
})

test('the pill sits in the middle of a bar and keeps its width', () => {
  const cells = withPill(barCells(30, 0, 'run', 50, ACCENT.sonnet), 'Tasks 2/4', ACCENT.sonnet)
  expect(cells.length).toBe(30)
  expect(cells.map(c => c[0]).join('')).toContain(' Tasks 2/4 ')
  // too narrow for the label: the bar is left alone
  expect(withPill(barCells(8, 0, 'run', 50, ACCENT.sonnet), 'Tasks 2/4', ACCENT.sonnet).map(c => c[0]).join('')).not.toContain('Tasks')
})
