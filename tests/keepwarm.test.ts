import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { WARM_EVERY_MS, warmEveryMin } from '../hooks/options'
import { fromJsonl, warmLine } from '../hooks/sessionlog'

// Keep-warm: busy cannot stay stuck, no due ping is skipped silently, and each ping logs what the cache did.

const HOME = 'C:/Users/me'
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const MIN = 60_000
// The ping interval in minutes, read from the constant so these tests hold for any CR_WARM_EVERY_MIN
const EVERY = WARM_EVERY_MS / MIN
type Reply = Record<string, unknown>
const WARM_REPLY: Reply = { isAnswered: true, text: 'WARMTEXT', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 } }

function world(on: On, replies: Reply[] = []) {
  const written: Record<string, string> = {}
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 18, 9, 30) })
  mock.env(on, { USERPROFILE: HOME })
  let forks = 0
  on('model.fork', () => { forks += 1; return { value: (replies.shift() ?? WARM_REPLY) as never } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  mock.session(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const text = written[e.path.split('\\').join('/')]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => { written[e.path.split('\\').join('/')] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  const warmLines = () => Object.keys(written).filter(p => p.endsWith('.jsonl')).flatMap(p => fromJsonl(written[p] ?? '')).filter(l => l.t === 'warm')
  return { written, clock, forks: () => forks, warmLines }
}

// advance() refuses a jump of more than 10000 timer waits, and the 100 ms frame timer fires all the while: go in 10-minute steps
async function idle(clock: { advance: (ms: number) => Promise<void> }, minutes: number) {
  for (let left = minutes; left > 0; left -= 10) await clock.advance(Math.min(left, 10) * MIN)
}
const step = async ($: any, id: string) => {
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 })) { /* drain */ }
}
async function start($: any, window = '3h') {
  await $.session.start({ cwd: 'C:/work/site', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'cr-warm', args: window, ...CMD })
}
const done = ($: any, id: string) => $.turn.complete({ turnId: id, reason: 'answer', isAborted: false, durationMs: 1, answer: '' })

test('a failed main turn (StopFailure) no longer holds busy: the ping still goes', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await $.classic.StopFailure({ error: 'server_error' } as never)
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(1)
})

test('an aborted main turn.complete clears busy: the ping still goes', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', reason: 'interrupted', isAborted: true, durationMs: 10, answer: '' } as never)
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(1)
})

test('busy held 20 minutes with no main step is cleared: the ping still goes', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, warmLines } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  // no turn.complete, no failure
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(1)
  expect(warmLines().filter(l => l.skip)).toHaveLength(0)
})

test('skip busy: a due ping held by a running turn logs one ok:false line, not one a minute', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, warmLines } = world(on)
  await start($)
  await $.turn.start({ turnId: 't0', text: 'first' })
  await step($, 't0')
  await done($, 't0')
  await idle(clock, EVERY - 1)
  // a new turn starts one minute before the ping falls due and has not stepped: busy when it does
  await $.turn.start({ turnId: 't1', text: 'second' })
  await idle(clock, 2)
  expect(forks()).toBe(0)
  expect(warmLines().map(l => [l.ok, l.skip])).toEqual([[false, 'busy']])
  // the safety clears busy 20 minutes after it started and the ping goes
  await idle(clock, 20)
  expect(forks()).toBe(1)
  expect(warmLines().filter(l => l.skip)).toHaveLength(1)
})

test('skip no-request: a window open with no main request logs once per idle period', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, warmLines } = world(on)
  await start($)
  await idle(clock, EVERY - 1)
  expect(warmLines()).toHaveLength(0)
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(0)
  expect(warmLines().map(l => [l.ok, l.skip])).toEqual([[false, 'no-request']])
})

test('skip window-closed: a due ping after the window ended logs once, again only after a new request', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, warmLines } = world(on)
  await start($, '1h')
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(1)
  // pings go on every EVERY minutes until the 1h window ends, then no more
  await idle(clock, 70)
  const sent = forks()
  expect(sent).toBeGreaterThan(1)
  await idle(clock, 30)
  expect(forks()).toBe(sent)
  expect(warmLines().filter(l => l.skip).map(l => l.skip)).toEqual(['window-closed'])
  // a new main request starts a new idle period
  await step($, 't1')
  await idle(clock, EVERY + 1)
  expect(warmLines().filter(l => l.skip).map(l => l.skip)).toEqual(['window-closed', 'window-closed'])
})

test('warm off logs no skip', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, warmLines } = world(on)
  await start($, 'off')
  await idle(clock, 120)
  expect(warmLines()).toHaveLength(0)
})

test('a ping logs the cache numbers and the main thread model, never its text', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, written, warmLines } = world(on, [{ ...WARM_REPLY, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 123_456, cache_creation_input_tokens: 789 } }])
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, EVERY + 1)
  const [line] = warmLines()
  // the router sends this prompt on Haiku: the line names the model the main thread last sent, not the one the step asked for
  expect(line).toMatchObject({ ok: true, cached: 123_456, written: 789, in: 3, out: 2, model: 'claude-haiku-5-5' })
  expect(line).not.toHaveProperty('skip')
  expect(line).not.toHaveProperty('usage')
  expect(JSON.stringify(written).includes('WARMTEXT')).toBe(false)
})

test('a fork result with no usage logs usage:none', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, warmLines } = world(on, [{ isAnswered: true, text: 'warm' }])
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, EVERY + 1)
  const [line] = warmLines()
  expect(line).toMatchObject({ ok: true, usage: 'none' })
  expect(line).not.toHaveProperty('cached')
})

test('warmLine: skip and usage fields', () => {
  expect(warmLine(1, 2, { minutesLeft: -3, ok: false, skip: 'busy' })).toEqual({ t: 'warm', at: 1, n: 2, minutesLeft: 0, ok: false, skip: 'busy' })
  expect(warmLine(1, 2, { minutesLeft: 10, ok: true, usage: 'none', model: 'm' })).toEqual({ t: 'warm', at: 1, n: 2, minutesLeft: 10, ok: true, usage: 'none', model: 'm' })
})

test('CR_WARM_EVERY_MIN: default 4, valid value used, invalid or under 1 ignored, capped at 55', () => {
  expect(warmEveryMin(undefined)).toBe(4)
  expect(warmEveryMin('')).toBe(4)
  expect(warmEveryMin('50')).toBe(50)
  expect(warmEveryMin('2.5')).toBe(2.5)
  expect(warmEveryMin('abc')).toBe(4)
  expect(warmEveryMin('0')).toBe(4)
  expect(warmEveryMin('0.5')).toBe(4)
  expect(warmEveryMin('-3')).toBe(4)
  expect(warmEveryMin('Infinity')).toBe(4)
  expect(warmEveryMin('120')).toBe(55)
  // the exported constant is the same value in ms, and the default sits under a 5-minute cache
  expect(WARM_EVERY_MS).toBe(warmEveryMin(process.env.CR_WARM_EVERY_MIN) * MIN)
})
