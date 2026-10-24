import { expect, test } from 'claude-code/testing'

import { directiveOf, guard, type GuardInput } from '../hooks/guard'
import { applyArgs, DEFAULT_OPTIONS } from '../hooks/options'

const BASE: GuardInput = {
  pick: { model: 'opus', effort: 'xhigh', conf: 0.9 },
  pin: null,
  maxEffort: 'high',
  budget: 3,
  ctxCap: 150_000,
  isSub: false,
  isPlan: false,
  step: 0,
  textLen: 200,
  turnTools: [],
  contextTokens: 20_000,
  turnCost: 0,
}

test('xhigh is never picked automatically', () => {
  expect(guard(BASE)).toMatchObject({ model: 'opus', effort: 'high' })
})

test('a long spec on Opus is capped at medium (the $26 turn)', () => {
  expect(guard({ ...BASE, textLen: 6000 })).toMatchObject({ model: 'opus', effort: 'medium' })
})

test('Opus plans, Sonnet executes', () => {
  expect(guard({ ...BASE, step: 2 })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(guard({ ...BASE, turnTools: ['Read', 'Write'] })).toMatchObject({ model: 'sonnet' })
  expect(guard({ ...BASE, turnTools: ['Read', 'Read', 'Read', 'Read', 'Read', 'Read'] })).toMatchObject({ model: 'sonnet' })
})

test('a subagent never runs on Opus unless it plans', () => {
  expect(guard({ ...BASE, isSub: true })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(guard({ ...BASE, isSub: true, isPlan: true })).toMatchObject({ model: 'opus', effort: 'high' })
})

test('a big context downgrades, a huge one goes to low', () => {
  expect(guard({ ...BASE, contextTokens: 160_000 })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(guard({ ...BASE, contextTokens: 255_000 })).toMatchObject({ model: 'sonnet', effort: 'low' })
  expect(guard({ ...BASE, contextTokens: 255_000, ctxCap: 0 }).model).toBe('opus')
})

test('the turn budget downgrades, and twice the budget goes to low', () => {
  expect(guard({ ...BASE, turnCost: 3.5 })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(guard({ ...BASE, turnCost: 6.5 })).toMatchObject({ model: 'sonnet', effort: 'low' })
  expect(guard({ ...BASE, turnCost: 99, budget: 0 }).model).toBe('opus')
})

test('a pin wins over every limit', () => {
  const g = guard({ ...BASE, pin: { model: 'opus', effort: 'xhigh' }, turnCost: 99, contextTokens: 400_000 })
  expect(g).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(guard({ ...BASE, pin: { model: 'sonnet', effort: null } })).toMatchObject({ model: 'sonnet', effort: 'medium' })
})

test('a prompt prefix pins one turn', () => {
  expect(directiveOf('@sonnet:med build the app')).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(directiveOf('@opus fix it')).toEqual({ model: 'opus', effort: null })
  expect(directiveOf('use @sonnet here')).toBe(null)
})

test('/clauderouter pin, cap, budget and ctx', () => {
  expect(applyArgs('pin sonnet med', DEFAULT_OPTIONS, 0).next).toMatchObject({ pin: 'sonnet', pinEffort: 'medium' })
  expect(applyArgs('pin auto', { ...DEFAULT_OPTIONS, pin: 'opus' }, 0).next).toMatchObject({ pin: null })
  expect(applyArgs('pin gpt', DEFAULT_OPTIONS, 0).next).toBe(null)
  expect(applyArgs('cap medium', DEFAULT_OPTIONS, 0).next?.maxEffort).toBe('medium')
  expect(applyArgs('budget $5', DEFAULT_OPTIONS, 0).next?.budget).toBe(5)
  expect(applyArgs('budget off', DEFAULT_OPTIONS, 0).next?.budget).toBe(0)
  expect(applyArgs('ctx 200k', DEFAULT_OPTIONS, 0).next?.ctxCap).toBe(200_000)
  expect(applyArgs('ctx lots', DEFAULT_OPTIONS, 0).next).toBe(null)
})
