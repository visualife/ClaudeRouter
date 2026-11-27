import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_OPTIONS, USAGE, applyArgs, describe } from '../hooks/options'
import { fallbackLine } from '../hooks/sessionlog'

// Fable out of usage: a rate-limit failure of a main-thread Fable request sends every Fable request to Opus until the reset.

const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const FABLE = 'claude-fable-5-2'
const OPUS = 'claude-opus-5-5'
const NOW = Date.UTC(2026, 10, 18, 9, 30)
type Limit = { kind: string; percentUsed: number; resetsAt?: string }
const usage = (rateLimits: Limit[]) => ({ startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits, cost: { usd: 0 } })

function world(on: On, limits: Limit[] = []) {
  const sent: string[] = []
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: usage(limits) }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.toast', () => ({ value: undefined }))
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* (_$, e) {
    sent.push(`${e.model}/${e.effort}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { sent, clock }
}

type Dollar = Engine

async function step($: Dollar, id: string, model: string) {
  await $.turn.start({ turnId: id, text: 'list the files and read the README' })
  for await (const _ of $.turn.step({ turnId: id, index: 0, model, effort: 'high', messageCount: 1 })) { /* drain */ }
}

const fail = ($: Dollar, error: string) => $.classic.StopFailure({ error, error_details: 'Fable usage limit reached, resets at 03:00' } as never)
const start = ($: Dollar) => $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })

test('a rate-limit failure of a Fable main request sends the next Fable request to Opus (fable lock)', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await step($, 't1', FABLE)
  expect(sent[0]).toBe(`${FABLE}/high`)
  await fail($, 'rate_limit')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
})

test('it also applies in claude mode and in orchestrator mode', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await $.command.run({ command: 'cr-mode', args: 'claude', ...CMD })
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
  await $.command.run({ command: 'cr-mode', args: 'router', ...CMD })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${OPUS}/high`)
})

test('a non-usage error does not trigger it, and nor does a failure on another model', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await step($, 't1', FABLE)
  await fail($, 'server_error')
  await fail($, 'overloaded')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${FABLE}/high`)
  await step($, 't3', 'claude-sonnet-5-5')
  await fail($, 'rate_limit')
  await step($, 't4', FABLE)
  expect(sent[3]).toBe(`${FABLE}/high`)
})

test('after the reset time of an exhausted window Fable returns', async ($, on) => {
  const { sent, clock } = world(on, [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 20 * 60_000).toISOString() }])
  await start($)
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await wait(clock, 19)
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
  await wait(clock, 2)
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${FABLE}/high`)
})

test('with no reset time known Opus holds for an hour', { timeoutMs: 60_000 }, async ($, on) => {
  const { sent, clock } = world(on)
  await start($)
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await wait(clock, 50)
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
  await wait(clock, 20)
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${FABLE}/high`)
})

test('the fallback log line carries a reason code, never the error text', () => {
  const line = fallbackLine(1, { from: FABLE, to: OPUS, until: 5, reason: 'rate_limit' })
  expect(line).toEqual({ t: 'fallback', at: 1, from: FABLE, to: OPUS, until: 5, reason: 'rate_limit' })
})

// ── Escape hatch, false positives, pin warning, probe ───────────────────────────────────────────────────────

const BAND = { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const run = ($: Dollar, command: string, args: string) => $.command.run({ command, args, ...CMD })
const failWith = ($: Dollar, error_details?: string) => $.classic.StopFailure({ error: 'rate_limit', ...(error_details === undefined ? {} : { error_details }) } as never)

// A world that also keeps the session log in memory
function logged(on: On, limits: Limit[] = []) {
  const written: Record<string, string> = {}
  const w = world(on, limits)
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.measure', () => ({ changed: ['rateLimits'] as never }))
  on('fs.read', (_$, e) => {
    const text = written[e.path.split('\\').join('/')]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => { written[e.path.split('\\').join('/')] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  const lines = () => Object.keys(written).filter(p => p.endsWith('.jsonl')).flatMap(p => (written[p] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
  return { ...w, lines, written }
}

test('/cr-fable reset ends the fallback now; the band warning goes too', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
  const text = (await run($, 'cr-fable', 'reset') as { text?: string }).text ?? ''
  expect(text).toContain('cleared')
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${FABLE}/high`)
  await run($, 'cr-band', 'route')
  const strip = await $.ui.mount({ plugin: 'agent-ClaudeRouter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await strip.find({ text: /Fable out of usage/ })).toBeUndefined()
  await strip.unmount()
})

test('/cr-fable off stops the fallback and clears a running one; on brings it back', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await run($, 'cr-fable', 'off')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${FABLE}/high`)
  await fail($, 'rate_limit')
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${FABLE}/high`)
  expect((await run($, 'cr-status', '') as { text?: string }).text).toContain('fable fallback: off')
  await run($, 'cr-fable', 'on')
  await fail($, 'rate_limit')
  await step($, 't4', FABLE)
  expect(sent[3]).toBe(`${OPUS}/high`)
})

test('applyArgs: fable on/off set the option, reset leaves it, a bad word says usage', () => {
  expect(applyArgs('fable off', DEFAULT_OPTIONS, 0).next?.fableFallback).toBe('off')
  expect(applyArgs('fable on', { ...DEFAULT_OPTIONS, fableFallback: 'off' }, 0).next?.fableFallback).toBe('on')
  expect(applyArgs('fable reset', DEFAULT_OPTIONS, 0).next).toEqual(DEFAULT_OPTIONS)
  expect(DEFAULT_OPTIONS.fableFallback).toBe('on')
  expect(applyArgs('fable nope', DEFAULT_OPTIONS, 0).next).toBeNull()
  expect(USAGE).toContain('/cr-fable reset')
  expect(describe(DEFAULT_OPTIONS, 0)).toContain('fable fallback: on')
})

test('a plain 429 triggers nothing; a second within 10 minutes holds Opus for 15', async ($, on) => {
  const { sent, clock } = world(on)
  await start($)
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  await step($, 't1', FABLE)
  await failWith($, 'Too many requests, please try again')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${FABLE}/high`)
  await wait(clock, 5)
  await failWith($)
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${OPUS}/high`)
  await wait(clock, 14)
  await step($, 't4', FABLE)
  expect(sent[3]).toBe(`${OPUS}/high`)
  await wait(clock, 2)
  await step($, 't5', FABLE)
  expect(sent[4]).toBe(`${FABLE}/high`)
})

test('two plain 429s more than 10 minutes apart trigger nothing', async ($, on) => {
  const { sent, clock } = world(on)
  await start($)
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  await step($, 't1', FABLE)
  await failWith($)
  await wait(clock, 11)
  await failWith($)
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${FABLE}/high`)
})

test('a window at 100% triggers on the first failure, with no details; "overloaded" details alone do not', async ($, on) => {
  const { sent } = world(on, [{ kind: 'weekly', percentUsed: 100, resetsAt: new Date(NOW + 30 * 60_000).toISOString() }])
  await start($)
  await step($, 't1', FABLE)
  await failWith($)
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${OPUS}/high`)
})

test('usage, limit or quota in the details trigger it; overloaded or try again do not', async ($, on) => {
  const { sent } = world(on)
  await start($)
  await step($, 't1', FABLE)
  await failWith($, 'Service overloaded, usage is high')
  await step($, 't2', FABLE)
  expect(sent[1]).toBe(`${FABLE}/high`)
  await run($, 'cr-fable', 'reset')
  await failWith($, 'You have hit your quota')
  await step($, 't3', FABLE)
  expect(sent[2]).toBe(`${OPUS}/high`)
})

test('a fallback that overrides a pin or the lock says so in the band', async ($, on) => {
  world(on)
  await start($)
  await run($, 'cr-band', 'route')
  await run($, 'cr-pin', 'fable')
  await step($, 't1', FABLE)
  await fail($, 'rate_limit')
  await step($, 't2', FABLE)
  const strip = await $.ui.mount({ plugin: 'agent-ClaudeRouter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await strip.find({ text: /Fable out of usage · Opus until \d\d:\d\d · pin paused/ })).toBeDefined()
  await strip.unmount()
  await run($, 'cr-pin', 'auto')
  await step($, 't3', FABLE)
  const lock = await $.ui.mount({ plugin: 'agent-ClaudeRouter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await lock.find({ text: /Opus until \d\d:\d\d · lock paused/ })).toBeDefined()
  await lock.unmount()
})

test('probe lines: failure and measure carry shapes only, never text; measure at most once per 10 minutes', async ($, on) => {
  const text = 'SECRET-TEXT usage limit reached'
  const { lines, written, clock } = logged(on, [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-18T12:00:00Z' }])
  await start($)
  await $.command.run({ command: 'cr-warm', args: 'off', ...CMD })
  await step($, 't1', FABLE)
  await $.session.measure({ context: { tokens: 1, window: 10, percent: 0 }, rateLimits: [{ kind: 'weekly', percentUsed: 7, resetsAt: '2026-11-20T00:00:00Z' }], cost: { usd: 0 } } as never)
  await $.session.measure({ context: { tokens: 2, window: 10, percent: 0 }, rateLimits: [], cost: { usd: 0 } } as never)
  expect(lines().filter(l => l.t === 'probe' && l.source === 'measure')).toHaveLength(1)
  await clock.advance(11 * 60_000)
  await $.session.measure({ context: { tokens: 3, window: 10, percent: 0 }, rateLimits: [], cost: { usd: 0 } } as never)
  expect(lines().filter(l => l.t === 'probe' && l.source === 'measure')).toHaveLength(2)
  await $.classic.StopFailure({ error: 'rate_limit', error_details: text } as never)
  await $.classic.StopFailure({ error: 'server_error', agent_id: 'a1' } as never)
  const probes = lines().filter(l => l.t === 'probe' && l.source === 'failure')
  expect(probes[0]).toMatchObject({ code: 'rate_limit', details: true, detailsLen: text.length, who: 'main', family: 'fable', limits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-18T12:00:00Z' }] })
  expect(probes[1]).toMatchObject({ code: 'server_error', details: false, detailsLen: null, who: 'agent' })
  expect(Object.values(written).join('\n')).not.toContain('SECRET-TEXT')
})

// Minutes pass in steps shorter than the keep-warm timer's interval
async function wait(clock: { advance: (ms: number) => Promise<unknown> }, minutes: number) {
  for (let left = minutes; left > 0; left -= 10) await clock.advance(Math.min(left, 10) * 60_000)
}
