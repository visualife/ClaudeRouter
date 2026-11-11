import { expect, test } from 'claude-code/testing'

import { guard, type GuardInput } from '../hooks/guard'
import { applyArgs, DEFAULT_OPTIONS, describe as describeOptions, normalize } from '../hooks/options'
import { copyFloor, creativeFloor, creativeOf, isCopy, pickRoute, whyOf } from '../hooks/route'

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

test('creative work is recognised in English and French, and "copy the file" is not', () => {
  for (const text of [
    'write the landing page copy for the cold brew launch',
    'give me 10 headlines for the hero',
    'rewrite the product description in our tone of voice',
    'draft a newsletter with 3 subject lines',
    'rédige la fiche produit du baume',
    'une accroche pour la page d’accueil',
  ]) expect(isCopy(text)).toBe(true)
  for (const text of [
    'copy the file to docs',
    'copy this function into utils.ts',
    'list the files',
    'fix the failing test',
    'fix the naming conventions in utils',
    'write a bash script to rename the logs',
    'translate this function to Python',
    'design the database schema',
    'corrige le positionnement du header en CSS',
  ]) expect(creativeOf(text)).toBe(null)
})

test('each creative case is told apart: flagship, craft, bulk', () => {
  for (const text of [
    'write a tagline',
    'art direction for the ParaLies launch film',
    'propose une direction artistique pour Infuzion',
    'brand identity and color palette for Ailive',
    'design a new logo for the dentist',
    'naming ideas for the AI voice agent service',
    'trouve des noms de domaine pour le produit',
    'a moodboard and key visual for the tea campaign',
    'storyboard for the 30s video script',
  ]) expect(creativeOf(text)).toBe('flagship')
  for (const text of [
    'rédige la fiche produit du baume',
    'write 3 instagram captions for the new tea',
    'image prompts for the hero shot in Magnific',
    'a photo brief for the product shoot',
    'translate the brand manifesto into Hebrew',
  ]) expect(creativeOf(text)).toBe('craft')
  for (const text of [
    'write product descriptions for all 40 products in the CSV',
    'rédige les fiches produit pour tout le catalogue',
    'traduis les fiches produit en anglais',
    'meta descriptions for every page',
    'alt text for the gallery images',
  ]) expect(creativeOf(text)).toBe('bulk')
})

test('the router sends each case to its tier', () => {
  expect(pickRoute({ text: 'write a tagline', tools: [] })).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(pickRoute({ text: 'write a tagline', tools: [], creative: 'fable' })).toMatchObject({ model: 'fable', effort: 'high' })
  expect(pickRoute({ text: 'rédige la fiche produit du baume', tools: [] })).toMatchObject({ model: 'opus', effort: 'high' })
  expect(pickRoute({ text: 'rédige la fiche produit du baume', tools: [], creative: 'fable' })).toMatchObject({ model: 'opus', effort: 'high' })
  expect(pickRoute({ text: 'meta descriptions for every page', tools: [] })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // off: routed like any other prompt
  expect(pickRoute({ text: 'write a tagline', tools: [], creative: 'off' }).model).not.toBe('opus')
  // without a creative signal the same shape of prompt stays on a lighter tier
  expect(pickRoute({ text: 'write a test', tools: [] }).model).not.toBe('opus')
  // an Explore subagent only reads: left alone
  expect(pickRoute({ text: 'find the landing page copy', tools: [], subagentType: 'Explore' }).model).toBe('haiku')
  expect(whyOf({ text: 'write a tagline', tools: [] })).toContain('kw:creative')
  expect(whyOf({ text: 'rédige la fiche produit', tools: [] })).toContain('kw:copy')
  expect(whyOf({ text: 'alt text for the gallery', tools: [] })).toContain('kw:copy·bulk')
})

test('the creative floor also sets a pick made by Jev', () => {
  const input = { text: 'three slogans for the brand', tools: [] }
  expect(creativeFloor({ model: 'haiku', effort: 'low', conf: 0.7 }, input)).toMatchObject({ model: 'opus', effort: 'xhigh', conf: 0.9 })
  expect(creativeFloor({ model: 'haiku', effort: 'low', conf: 0.7 }, input, 'fable')).toMatchObject({ model: 'fable', effort: 'high' })
  expect(copyFloor({ model: 'haiku', effort: 'low', conf: 0.7 }, { text: 'list the files', tools: [] })).toMatchObject({ model: 'haiku', effort: 'low' })
})

test('the guard keeps creative work strong, with its own effort ceiling', () => {
  // an ordinary Opus turn moves to Sonnet medium once it writes files
  expect(guard({ ...base, step: 4, turnTools: ['Write'] })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  // a creative turn does not
  expect(guard({ ...base, creative: 'craft', step: 4, turnTools: ['Write'], textLen: 5000 })).toMatchObject({ model: 'opus', effort: 'high' })
  // flagship work runs at xhigh above the general ceiling (high), unless the creative cap is lowered
  const flagship = { ...base, pick: { model: 'opus' as const, effort: 'xhigh' as const, conf: 0.9 }, creative: 'flagship' as const }
  expect(guard(flagship)).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(guard({ ...flagship, creativeCap: 'high' })).toMatchObject({ model: 'opus', effort: 'high' })
  // Fable picked for flagship work keeps the whole turn
  expect(guard({ ...flagship, pick: { model: 'fable', effort: 'high', conf: 0.9 }, step: 5, turnTools: ['Write'] })).toMatchObject({ model: 'fable', effort: 'high' })
  // over the budget or the context cap the model goes down, the effort stays high
  expect(guard({ ...flagship, turnCost: 10 })).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(guard({ ...base, creative: 'craft', contextTokens: 400_000 })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // a creative subagent runs on Sonnet, at high effort, Fable included
  expect(guard({ ...base, creative: 'craft', isSub: true })).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(guard({ ...flagship, pick: { model: 'fable', effort: 'high', conf: 0.9 }, isSub: true })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // bulk stays on Sonnet high
  expect(guard({ ...base, pick: { model: 'sonnet', effort: 'high', conf: 0.9 }, creative: 'bulk' })).toMatchObject({ model: 'sonnet', effort: 'high' })
  // the user's pin still wins
  expect(guard({ ...flagship, pin: { model: 'haiku', effort: null } }).model).toBe('haiku')
})

test('/clauderouter creative sets the flagship model and the creative ceiling', () => {
  expect(DEFAULT_OPTIONS).toMatchObject({ creative: 'opus', creativeCap: 'xhigh' })
  // options saved by 0.4.2 get the creative defaults
  expect(normalize({ engine: 'rules' })).toMatchObject({ creative: 'opus', creativeCap: 'xhigh' })
  expect(applyArgs('creative fable', DEFAULT_OPTIONS, 0).next?.creative).toBe('fable')
  expect(applyArgs('creative off', DEFAULT_OPTIONS, 0).next?.creative).toBe('off')
  expect(applyArgs('creative cap high', DEFAULT_OPTIONS, 0).next?.creativeCap).toBe('high')
  expect(applyArgs('creative cap max', DEFAULT_OPTIONS, 0).next).toBe(null)
  expect(applyArgs('creative gpt', DEFAULT_OPTIONS, 0).next).toBe(null)
  expect(describeOptions(DEFAULT_OPTIONS, 0)).toContain('creative: opus (cap xhigh)')
})
