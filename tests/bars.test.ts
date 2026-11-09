import { expect, test } from 'claude-code/testing'

import { ACCENT, barCells, filledOf, withPill } from '../hooks/pixel'

const SOLID = /[█⣿]/
// Brightness of a colour: the sum of its channels
const lum = (c: number | undefined) => (((c ?? 0) >> 16) & 0xff) + (((c ?? 0) >> 8) & 0xff) + ((c ?? 0) & 0xff)

test('bars are dot textures: no tone, percent or frame draws a solid cell', () => {
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

test('the fill reveals one fixed texture: the track ahead has the same dots, only dimmer', () => {
  const half = barCells(20, 0, 'run', 50, ACCENT.sonnet)
  const full = barCells(20, 0, 'run', 100, ACCENT.sonnet)
  const none = barCells(20, 0, 'run', null, ACCENT.sonnet)
  // the same glyph in every column whatever the value, except the head marker that ends the fill
  expect(half.map(c => c[0]).join('')).toBe(none.map(c => c[0]).join(''))
  expect(full.map(c => c[0]).join('')).toBe(none.map(c => c[0]).join(''))
  // every filled dot is brighter than every dot still ahead
  const fill = half.slice(0, 10).map(c => lum(c[1]))
  const ahead = half.slice(10).map(c => lum(c[1]))
  expect(Math.min(...fill)).toBeGreaterThan(Math.max(...ahead))
})

test('opacity is eased, not linear: the fill brightens slowly then fast toward its edge, and the track ahead fades out', () => {
  const cells = barCells(40, 0, 'run', 100, ACCENT.sonnet)
  const l = cells.map(c => lum(c[1]))
  const first = Math.min(...l.slice(0, 4))
  const last = Math.max(...l.slice(-4))
  expect(last).toBeGreaterThan(first)
  // a linear ramp would put the middle at the average of the two ends; an eased one sits well below it
  const mid = l.slice(18, 22).reduce((a, b) => a + b, 0) / 4
  expect(mid).toBeLessThan((first + last) / 2)
  // ahead of the fill the dots fade the further they are
  const ahead = barCells(40, 0, 'run', 10, ACCENT.sonnet).slice(4).map(c => lum(c[1]))
  expect(ahead[0]).toBeGreaterThan(ahead[ahead.length - 1] ?? 0)
})

test('nothing moves: a bar is the same on every frame, and the fill is the value', () => {
  const at = (pct: number | null, frame: number) => barCells(30, frame, 'run', pct, ACCENT.sonnet).map(c => c[0] + c[1]).join('')
  expect(at(40, 0)).toBe(at(40, 8))
  expect(at(null, 0)).toBe(at(null, 8))
  // no reading: nothing is filled; a reading fills that share
  expect(filledOf(30, null)).toBe(0)
  expect(filledOf(30, 0)).toBe(0)
  expect(filledOf(30, 50)).toBe(15)
  expect(filledOf(30, 100)).toBe(30)
  expect(filledOf(30, 250)).toBe(30)
})

test('a finished or failed bar still shows its value; failed is red', () => {
  expect(filledOf(20, 25)).toBe(5)
  const fail = barCells(20, 0, 'fail', 100, ACCENT.sonnet)
  // every filled dot is red-dominant
  expect(fail.every(c => ((c[1] >> 16) & 0xff) > ((c[1] >> 8) & 0xff) && ((c[1] >> 16) & 0xff) > (c[1] & 0xff))).toBe(true)
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
