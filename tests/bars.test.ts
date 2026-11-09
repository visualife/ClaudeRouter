import { expect, test } from 'claude-code/testing'

import { ACCENT, barCells, filledOf, withPill } from '../hooks/pixel'

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

test("the fill reveals one fixed texture: the ghost ahead of it has the same dots, only dimmer", () => {
  const half = barCells(20, 0, "run", 50, ACCENT.sonnet)
  const full = barCells(20, 0, "run", 100, ACCENT.sonnet)
  const none = barCells(20, 0, "run", null, ACCENT.sonnet)
  expect(half.slice(10).every(c => c[1] === ACCENT.track)).toBe(true)
  expect(half.slice(0, 10).every(c => c[1] !== ACCENT.track)).toBe(true)
  // the same glyph in every column whatever the value
  expect(half.map(c => c[0]).join("")).toBe(full.map(c => c[0]).join(""))
  expect(none.map(c => c[0]).join("")).toBe(full.map(c => c[0]).join(""))
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

test('the capsule rides the edge of the fill and stays inside the bar', () => {
  const at = (pct: number | null) => {
    const cells = withPill(barCells(40, 0, 'run', pct, ACCENT.sonnet), 'Tasks 2/4', ACCENT.sonnet, filledOf(40, pct))
    return cells.map(c => c[0]).join('').indexOf(' Tasks 2/4 ')
  }
  expect(at(null)).toBe(0)
  expect(at(25)).toBe(10)
  expect(at(50)).toBe(20)
  // near the end it is held inside the bar
  expect(at(100)).toBe(40 - ' Tasks 2/4 '.length)
})
