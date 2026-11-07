import { expect, test } from 'claude-code/testing'

import { directiveOf, guard } from '../hooks/guard'
import { applyArgs, DEFAULT_OPTIONS } from '../hooks/options'
import { familyOf, idFor, MODEL_IDS, pickRoute } from '../hooks/route'

// Regression: a session on Fable was rewritten to Sonnet or Haiku on every request, because Fable was not a
// known family and idFor fell back to `claude-${family}-5-5`.

const BASE = {
  pick: { model: 'opus' as const, effort: 'xhigh' as const, conf: 0.9 },
  pin: null,
  maxEffort: 'high' as const,
  budget: 3,
  ctxCap: 150_000,
  isSub: false,
  isPlan: false,
  step: 0,
  textLen: 100,
  turnTools: [] as string[],
  contextTokens: null,
  turnCost: null,
}

test('a Fable id is recognised as Fable', () => {
  expect(familyOf('claude-fable-5-1')).toBe('fable')
  expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
})

test('idFor keeps a Fable id and never invents one', () => {
  expect(idFor('fable', 'claude-fable-5-1')).toBe('claude-fable-5-1')
  expect(idFor('sonnet', 'claude-fable-5-1')).toBe(MODEL_IDS.sonnet)
  expect(idFor('fable', 'claude-sonnet-5-5')).toBe('claude-fable-5-1')
  // unchanged behaviour between the three tiers: the version suffix is kept
  expect(idFor('haiku', 'claude-opus-5-5')).toBe('claude-haiku-5-5')
  expect(idFor('opus', 'something-unknown')).toBe('claude-opus-5-5')
})

test('a running Fable model does not break routing, and Fable is never picked by itself', () => {
  const pick = pickRoute({ text: 'why list', tools: [], current: 'fable' })
  expect(pick.model).toBe('sonnet')
  const heavy = pickRoute({ text: 'plan the architecture and debug the token check across modules', tools: [], current: 'fable' })
  expect(heavy.model).toBe('opus')
})

test('a pin on Fable wins over every limit', () => {
  const g = guard({ ...BASE, pin: { model: 'fable', effort: null }, turnCost: 99, contextTokens: 400_000 })
  expect(g).toMatchObject({ model: 'fable', effort: 'high' })
})

test('@fable pins one prompt', () => {
  expect(directiveOf('@fable:med write the page')).toEqual({ model: 'fable', effort: 'medium' })
})

test('/clauderouter knows Fable', () => {
  expect(DEFAULT_OPTIONS.fableLock).toBe(true)
  expect(applyArgs('pin fable', DEFAULT_OPTIONS, 0).next).toMatchObject({ pin: 'fable' })
  expect(applyArgs('fable auto', DEFAULT_OPTIONS, 0).next).toMatchObject({ fableLock: false })
  expect(applyArgs('fable lock', { ...DEFAULT_OPTIONS, fableLock: false }, 0).next).toMatchObject({ fableLock: true })
  expect(applyArgs('fable maybe', DEFAULT_OPTIONS, 0).next).toBe(null)
  expect(applyArgs('status', DEFAULT_OPTIONS, 0).text).toContain('fable lock: on')
})
