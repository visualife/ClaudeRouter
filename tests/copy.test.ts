import { expect, test } from 'claude-code/testing'

import { guard, type GuardInput } from '../hooks/guard'
import { copyFloor, isCopy, pickRoute, whyOf } from '../hooks/route'

const base: GuardInput = {
  pick: { model: 'opus', effort: 'high', conf: 0.9 },
  pin: null,
  maxEffort: 'high',
  budget: 3,
  ctxCap: 150_000,
  isSub: false,
  isPlan: false,
  step: 0,
  textLen: 80,
  turnTools: [],
  contextTokens: null,
  turnCost: null,
}

test('copywriting is recognised in English and French, and "copy the file" is not', () => {
  for (const text of [
    'write the landing page copy for the cold brew launch',
    'give me 10 headlines for the hero',
    'rewrite the product description in our tone of voice',
    'draft a newsletter with 3 subject lines',
    'rédige la fiche produit du baume',
    'une accroche pour la page d’accueil',
  ]) expect(isCopy(text)).toBe(true)
  for (const text of ['copy the file to docs', 'copy this function into utils.ts', 'list the files', 'fix the failing test']) expect(isCopy(text)).toBe(false)
})

test('a copy prompt routes to Opus at high effort, even a short one that would otherwise be light', () => {
  expect(pickRoute({ text: 'write a tagline', tools: [] })).toMatchObject({ model: 'opus', effort: 'high' })
  // without the copy signal the same shape of prompt stays on a lighter tier
  expect(pickRoute({ text: 'write a test', tools: [] }).model).not.toBe('opus')
  // an Explore subagent only reads: left alone
  expect(pickRoute({ text: 'find the landing page copy', tools: [], subagentType: 'Explore' }).model).toBe('haiku')
  expect(whyOf({ text: 'write a tagline', tools: [] })).toContain('kw:copy')
})

test('the copy floor also raises a pick made by Jev', () => {
  const input = { text: 'three slogans for the brand', tools: [] }
  expect(copyFloor({ model: 'haiku', effort: 'low', conf: 0.7 }, input)).toMatchObject({ model: 'opus', effort: 'high', conf: 0.9 })
  expect(copyFloor({ model: 'haiku', effort: 'low', conf: 0.7 }, { text: 'list the files', tools: [] })).toMatchObject({ model: 'haiku', effort: 'low' })
})

test('the guard keeps copy strong: Opus for the whole turn, and a high effort where a limit takes the model down', () => {
  // an ordinary Opus turn moves to Sonnet medium once it writes files
  expect(guard({ ...base, step: 4, turnTools: ['Write'] })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  // a copy turn does not
  expect(guard({ ...base, isCopy: true, step: 4, turnTools: ['Write'], textLen: 5000 })).toMatchObject({ model: 'opus', effort: 'high' })
  // over the budget or the context cap the model goes down, the effort stays high
  expect(guard({ ...base, isCopy: true, turnCost: 10 })).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(guard({ ...base, isCopy: true, contextTokens: 400_000 })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // a copy subagent runs on Sonnet, at high effort
  expect(guard({ ...base, isCopy: true, isSub: true })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // the user's effort ceiling and pin still win
  expect(guard({ ...base, isCopy: true, maxEffort: 'medium' }).effort).toBe('medium')
  expect(guard({ ...base, isCopy: true, pin: { model: 'haiku', effort: null } }).model).toBe('haiku')
})
