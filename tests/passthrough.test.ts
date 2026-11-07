import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Regression: the router rewrote every request of a Fable session, and of a subagent whose Agent call named a
// model, to Sonnet or Haiku. Both are now passed through untouched.

const USAGE = { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0.01 } }

function world(on: On, spawn?: (e: { model?: string }) => { model: string; agentId: string }) {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', (_$, e) => (spawn ? spawn(e) : { model: e.model ?? 'haiku', agentId: 'a1' }))
  return clock
}

const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* chunks not needed */ } }

test('a Fable session is passed through untouched (fable lock)', async ($, on) => {
  world(on)
  let sent = ''
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'list the files and read the README' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 }))
  expect(sent).toBe('claude-fable-5-1/high')
})

test('an unknown model id is never rewritten', async ($, on) => {
  world(on)
  let sent = ''
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'list the files and read the README' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-next-9', effort: 'medium', messageCount: 1 }))
  expect(sent).toBe('claude-next-9/medium')
})

test('a subagent whose Agent call named a model keeps it on every request', async ($, on) => {
  world(on)
  let sent = ''
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'review the copy' })
  await $.agent.spawn({
    tool_use_id: 'u1', prompt: 'review every proposal', description: 'Fable review', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-fable-5-1', background: true, fork: false, model: 'claude-fable-5-1',
  })
  await drain($.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: 'claude-fable-5-1', effort: 'high', messageCount: 1 }))
  expect(sent).toBe('claude-fable-5-1/high')
})

test('a subagent with no named model is still routed', async ($, on) => {
  world(on)
  let sent = ''
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'map the routes' })
  await $.agent.spawn({
    tool_use_id: 'u1', prompt: 'find where the routes are defined', description: 'Map the routes', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: true, fork: false,
  })
  await drain($.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 }))
  expect(sent).toBe('claude-haiku-5-5/low')
})

test('a subagent of a locked session inherits the model and stays on it', async ($, on) => {
  let spawned = ''
  let sent = ''
  world(on, e => { spawned = e.model ?? ''; return { model: e.model ?? 'haiku', agentId: 'a1' } })
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'map the routes' })
  await $.agent.spawn({
    tool_use_id: 'u1', prompt: 'find where the routes are defined', description: 'Map the routes', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-fable-5-1', background: true, fork: false,
  })
  expect(spawned).toBe('claude-fable-5-1')
  await drain($.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: 'claude-fable-5-1', effort: 'high', messageCount: 1 }))
  expect(sent).toBe('claude-fable-5-1/high')
})
