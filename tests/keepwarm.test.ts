import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { WARM_DEFAULT_MS, WARM_EVERY_MS, warmAuto, warmEveryMin } from '../hooks/options'
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
  const allWarm = () => Object.keys(written).filter(p => p.endsWith('.jsonl')).flatMap(p => fromJsonl(written[p] ?? '')).filter(l => l.t === 'warm')
  // ping and skip lines (no `event` field), and the window events (armed, closed, ping-failed, skipped, heartbeat)
  const warmLines = () => allWarm().filter(l => l.event === undefined)
  const events = (name?: string) => allWarm().filter(l => l.event !== undefined && (name === undefined || l.event === name))
  return { written, clock, forks: () => forks, warmLines, events }
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
  // a new main request starts a new idle period; /cr-warm off first, or the request would arm a window of its own
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
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

// ── Window events in the log: armed, closed, skipped (not-due), ping-failed, heartbeat ─────────────────────────
const T0 = Date.UTC(2026, 10, 18, 9, 30)

test('event armed: /cr-warm logs the window with its minutes and deadline, no text', { timeoutMs: 120_000 }, async ($, on) => {
  const { events } = world(on)
  await start($, '2h')
  expect(events()).toHaveLength(1)
  expect(events('armed')[0]).toMatchObject({ t: 'warm', event: 'armed', via: 'command', minutes: 120, until: T0 + 120 * MIN })
  expect(Object.keys(events('armed')[0] ?? {}).sort()).toEqual(['at', 'event', 'minutes', 'n', 't', 'until', 'via'])
})

test('event closed: deadline passed logs once, /cr-warm off logs once, never-armed off logs nothing', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, events } = world(on)
  await start($, '1h')
  await idle(clock, 70)
  expect(events('closed').map(l => l.reason)).toEqual(['deadline'])
  await idle(clock, 30)
  expect(events('closed')).toHaveLength(1)
  // armed again, then closed by hand
  await $.command.run({ command: 'cr-warm', args: '2h', ...CMD })
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  expect(events('closed').map(l => l.reason)).toEqual(['deadline', 'off'])
})

test('event closed: off with no window armed logs no event', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, events } = world(on)
  await start($, 'off')
  await idle(clock, 30)
  expect(events()).toHaveLength(0)
})

test('events ping-failed and closed(failed-ping): an unanswered ping logs the error class, never text', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, written, events } = world(on, [{ isAnswered: false, text: 'WARMTEXT' }])
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, EVERY + 1)
  expect(events('ping-failed').map(l => l.error)).toEqual(['not-answered'])
  expect(events('closed').map(l => l.reason)).toEqual(['failed-ping'])
  expect(JSON.stringify(written).includes('WARMTEXT')).toBe(false)
})

test('event skipped (not-due): logged once after a request, then silent until the ping or a new request', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, 1)
  expect(events('skipped').map(l => l.reason)).toEqual(['not-due'])
  expect(Object.keys(events('skipped')[0] ?? {}).sort()).toEqual(['at', 'event', 'minutesLeft', 'n', 'reason', 'secToNextPing', 't'])
  // the rest of the wait adds nothing
  await idle(clock, EVERY - 2)
  expect(events('skipped')).toHaveLength(1)
  expect(forks()).toBe(0)
  // the ping goes and starts a new idle period: one more line
  await idle(clock, 2)
  expect(forks()).toBe(1)
  await idle(clock, 1)
  expect(events('skipped')).toHaveLength(2)
})

test('event heartbeat: every 10 minutes while armed and idle, with idle and next-ping timings', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, events } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, 9)
  expect(events('heartbeat')).toHaveLength(0)
  await idle(clock, 51)
  const beats = events('heartbeat')
  expect(beats.length).toBeGreaterThanOrEqual(5)
  expect(beats.length).toBeLessThanOrEqual(6)
  for (let i = 1; i < beats.length; i++) expect(Number(beats[i]?.at) - Number(beats[i - 1]?.at)).toBeGreaterThanOrEqual(10 * MIN)
  expect(Object.keys(beats[0] ?? {}).sort()).toEqual(['alive', 'at', 'event', 'hasRequest', 'idleSec', 'minutesLeft', 'n', 'secToNextPing', 't'])
  expect(beats[0]).toMatchObject({ alive: true, hasRequest: true })
  expect(Number(beats[0]?.idleSec)).toBeLessThanOrEqual(EVERY * 60)
  expect(Number(beats[0]?.secToNextPing)).toBeLessThanOrEqual(EVERY * 60)
})

test('no per-tick spam: an hour of idle window writes only heartbeats, one not-due line per ping cycle and the pings', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events, warmLines } = world(on)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await step($, 't1')
  await done($, 't1')
  await idle(clock, 60)
  const ticks = 60
  const total = events().length + warmLines().length
  // far fewer lines than ticks: 6 heartbeats at most, a not-due line per cycle, one ping line per ping, and the armed line
  expect(total).toBeLessThanOrEqual(1 + 6 + (forks() + 1) + forks())
  expect(total).toBeLessThan(ticks / 2)
  expect(events().every(l => ['armed', 'heartbeat', 'skipped'].includes(String(l.event)))).toBe(true)
})

// ── Auto-arm: the first real main-thread request opens a window, requests roll it, /cr-warm off and CR_WARM_AUTO=0 stop it ──
const DEFAULT_MIN = WARM_DEFAULT_MS / MIN
// A session nobody armed: no /cr-warm command
const begin = ($: any) => $.session.start({ cwd: 'C:/work/site', surface: 'terminal', isInteractive: true })
const request = async ($: any, id: string) => {
  await $.turn.start({ turnId: id, text: 'list the files' })
  await step($, id)
  await done($, id)
}

test('auto-arm: the first main request opens a WARM_DEFAULT_MS window and logs armed via auto', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events } = world(on)
  await begin($)
  expect(events()).toHaveLength(0)
  await request($, 't1')
  expect(events('armed')).toHaveLength(1)
  expect(events('armed')[0]).toMatchObject({ event: 'armed', via: 'auto', minutes: DEFAULT_MIN, until: T0 + WARM_DEFAULT_MS })
  expect(Object.keys(events('armed')[0] ?? {}).sort()).toEqual(['at', 'event', 'minutes', 'n', 't', 'until', 'via'])
  // the window works: a ping goes out after one idle interval
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(1)
  // a second request in the same window does not log armed again
  await request($, 't2')
  expect(events('armed')).toHaveLength(1)
})

test('auto-arm: a sub-agent request does not arm a window', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events } = world(on)
  await begin($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 } as never)) { /* drain */ }
  expect(events('armed')).toHaveLength(0)
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(0)
})

test('auto-arm rolls: a request pushes the deadline to now + WARM_DEFAULT_MS, a ping does not', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, events } = world(on)
  await begin($)
  await request($, 't1')
  await idle(clock, 60)
  await request($, 't2')
  // past the first deadline (T0 + default) the window is still open
  await idle(clock, DEFAULT_MIN - 60 + 30)
  expect(events('closed')).toHaveLength(0)
  // pings in between extended nothing: it closes at the second request's time + WARM_DEFAULT_MS
  await idle(clock, 60)
  expect(events('closed').map(l => [l.reason, l.until])).toEqual([['deadline', T0 + 60 * MIN + WARM_DEFAULT_MS]])
  expect(events('armed')).toHaveLength(1)
})

test('a manual window is not shortened, extended or taken over by a request', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, events } = world(on)
  await begin($)
  await $.command.run({ command: 'cr-warm', args: '30m', ...CMD })
  await request($, 't1')
  await idle(clock, 10)
  await request($, 't2')
  await idle(clock, 40)
  expect(events('armed').map(l => l.via)).toEqual(['command'])
  expect(events('closed').map(l => [l.reason, l.until])).toEqual([['deadline', T0 + 30 * MIN]])
})

test('/cr-warm off ends auto-arm for the session: the next request does not re-arm', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events } = world(on)
  await begin($)
  await request($, 't1')
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  expect(events('closed').map(l => l.reason)).toEqual(['off'])
  await request($, 't2')
  await idle(clock, EVERY + 1)
  expect(events('armed').map(l => l.via)).toEqual(['auto'])
  expect(forks()).toBe(0)
})

test('CR_WARM_AUTO: on unless 0, off or false', () => {
  for (const on of [undefined, '', '1', 'on', 'true', 'yes', 'abc']) expect(warmAuto(on)).toBe(true)
  for (const off of ['0', 'off', 'OFF', 'false', 'False', ' 0 ']) expect(warmAuto(off)).toBe(false)
})

test('a failed ping closes the window and does not re-arm until the next real request', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks, events } = world(on, [{ isAnswered: false, text: 'x' }])
  await begin($)
  await request($, 't1')
  await idle(clock, EVERY + 1)
  expect(events('closed').map(l => l.reason)).toEqual(['failed-ping'])
  await idle(clock, 60)
  expect(events('armed')).toHaveLength(1)
  expect(forks()).toBe(1)
  await request($, 't2')
  expect(events('armed').map(l => l.via)).toEqual(['auto', 'auto'])
  await idle(clock, EVERY + 1)
  expect(forks()).toBe(2)
})
