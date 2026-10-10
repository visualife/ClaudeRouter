import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { askJev } from '../hooks/jev'
import { applyArgs, DEFAULT_OPTIONS } from '../hooks/options'
import { pickRoute, roleOf } from '../hooks/route'

const PLUGIN = 'agent-ClaudeRouter'
const SCROLL = { offset: 0, bodyRows: 20 }
const BAND = { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 100, scroll: SCROLL, view: {} }
const PANE = { title: 'ClaudeRouter', isFocused: false, bodyColumns: 100, placement: 'inline' as const, scroll: SCROLL, view: {} }
const USAGE = {
  startedAt: 0,
  context: { tokens: 124_000, window: 1_000_000, percent: 12 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 31 },
    { kind: 'seven_day', percentUsed: 64 },
  ],
  cost: { usd: 0.32 },
}

// The engine's side of the events the mod touches: what a real session answers beneath the plugin
function world(on: On) {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'haiku', agentId: 'a1' }))
  return clock
}

test('a short read-only request routes to haiku at low effort', () => {
  const pick = pickRoute({ text: 'list the files here and read the README', tools: [] })
  expect(pick.model).toBe('haiku')
  expect(pick.effort).toBe('low')
})

test('planning and debugging across modules route to opus', () => {
  const pick = pickRoute({
    text: 'plan the architecture and debug the token check across modules',
    tools: [],
  })
  expect(pick.model).toBe('opus')
})

test('an Explore subagent routes to haiku', () => {
  const pick = pickRoute({ text: 'find where the routes are defined', tools: [], subagentType: 'Explore' })
  expect(pick.model).toBe('haiku')
})

// The design's sample routes (R in the HTML handoff)
const SAMPLES = [
  { text: 'debug why the refresh token check fails', tools: ['Bash', 'Edit'], model: 'opus' },
  { text: 'trace the 401 in middleware/auth.ts', tools: ['Read', 'Grep'], model: 'opus' },
  { text: 'list files under src/routes', tools: ['Glob'], model: 'haiku' },
  { text: 'rename authUser to currentUser', tools: ['Edit'], model: 'haiku' },
  { text: 'write fixtures for the login flow', tools: ['Write'], model: 'sonnet' },
  { text: 'plan the session store migration', tools: [], model: 'opus', effort: 'xhigh' },
] as const

test("the design's sample prompts route as drawn", () => {
  for (const s of SAMPLES) {
    const pick = pickRoute({ text: s.text, tools: s.tools })
    expect(`${s.text} → ${pick.model}`).toBe(`${s.text} → ${s.model}`)
    if ('effort' in s) expect(pick.effort).toBe(s.effort)
    expect(pick.conf >= 0.5 && pick.conf <= 0.99).toBe(true)
  }
})

test('subagents wear a role by type and task', () => {
  expect(roleOf('Explore', 'map the routes')).toBe('scout')
  expect(roleOf('Plan', 'outline the migration')).toBe('planner')
  expect(roleOf('general-purpose', 'verify token expiry')).toBe('researcher')
  expect(roleOf('general-purpose', 'write fixtures')).toBe('builder')
})

test('turn.step goes down on the routed model and effort', async ($, on) => {
  world(on)
  let sent = ''
  on('turn.step', async function* (_$, e) {
    sent = `${e.model}/${e.effort}`
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.turn.start({ turnId: 't1', text: 'list the files and read the README' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _ of step) {
    // the response chunks are not needed
  }
  expect(sent).toBe('claude-haiku-5-5/low')
})

// The band and the pane draw a running task with a subagent on every surface that takes them;
// the engine refuses a tree its table cannot draw, so a mount that resolves is a valid drawing.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band and the pane draw on ${surface}`, async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.turn.start({ turnId: 't1', text: 'plan the architecture and debug the token check' })
    await $.agent.spawn({
      tool_use_id: 'u1',
      prompt: 'find where the routes are defined',
      description: 'Map the routes',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })

    const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /ClaudeRouter/ })).toBeDefined()
    expect(await band.find({ text: /Model route/ })).toBeDefined()
    expect(await band.find({ text: /0\/1 agents/ })).toBeDefined()
    expect(await band.find({ text: /Map the routes/ })).toBeDefined()
    expect(await band.find({ text: /Weekly/ })).toBeDefined()
    // Raster is the terminal's alone: the desktop draws its bars as Text
    expect((await band.findAll({ type: 'Raster' })).length > 0).toBe(surface === 'terminal')
    await band.unmount()

    const pane = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE })
    expect(await pane.find({ text: /Running · 2/ })).toBeDefined()
    expect(await pane.find({ text: /Finished · 0/ })).toBeDefined()
    expect(await pane.find({ text: /Cost/ })).toBeDefined()
    await pane.unmount()
  })
}

test('while a turn runs the terminal repaints its shimmering bars with $.ui.blit', async ($, on) => {
  const clock = world(on)
  const blits: { requestId: string; key: string; cells: string }[] = []
  on('ui.blit', (_$, e) => {
    if ('cells' in e) blits.push({ requestId: e.requestId, key: e.key, cells: e.cells })
    return { value: {} }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'plan the architecture' })
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAND })

  await clock.advance(400)
  const keys = new Set(blits.map(b => b.key))
  expect(keys.has('task-t1')).toBe(true)
  expect(keys.has('crab-router')).toBe(true)
  // A bar of 30 cells is 30 triplets of 4 bytes: 360 bytes, 480 base64 characters
  expect(blits.find(b => b.key === 'task-t1')?.cells.length).toBe(480)
  expect(blits.every(b => b.requestId === 'band')).toBe(true)

  // Nothing is repainted once the turn is over
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 300, answer: '' })
  const before = blits.length
  await clock.advance(400)
  expect(blits.length).toBe(before)
  await band.unmount()
})

test('hysteresis keeps the current model on a tie, but not on a clear win', () => {
  // "why list": haiku and opus tie, so sonnet by default — unless a tied model is already running
  expect(pickRoute({ text: 'why list', tools: [] }).model).toBe('sonnet')
  expect(pickRoute({ text: 'why list', tools: [], current: 'opus' }).model).toBe('opus')
  // a clear sonnet win does not hold the old model
  expect(pickRoute({ text: 'fix the login bug in the form', tools: [], current: 'opus' }).model).toBe('sonnet')
})

const ok = (body: unknown) => async () => ({ ok: true, text: JSON.stringify(body) })
const INPUT = { text: 'debug the race in the token refresh', tools: [] }

test('Jev picks a tier from the Choice answer', async () => {
  const pick = await askJev(ok({ answers: { route: { choice: 'opus', probabilities: { opus: 0.82 } } } }), 'k', INPUT)
  expect(pick).toMatchObject({ model: 'opus', conf: 0.82 })
})

test('Jev failures all return null so the rules take over', async () => {
  expect(await askJev(async () => ({ ok: false, text: '' }), 'k', INPUT)).toBe(null)
  expect(await askJev(async () => { throw new Error('offline') }, 'k', INPUT)).toBe(null)
  expect(await askJev(ok({ answers: { route: { choice: 'gpt', probabilities: {} } } }), 'k', INPUT)).toBe(null)
  expect(await askJev(async () => ({ ok: true, text: 'not json' }), 'k', INPUT)).toBe(null)
})

test('/clauderouter options: engine and keep-warm', () => {
  const jev = applyArgs('engine jev', DEFAULT_OPTIONS, 0)
  expect(jev.next?.engine).toBe('jev')
  expect(applyArgs('engine gpt', DEFAULT_OPTIONS, 0).next).toBe(null)
  expect(applyArgs('warm 90m', DEFAULT_OPTIONS, 1000).next?.warmUntil).toBe(1000 + 90 * 60_000)
  expect(applyArgs('warm 99h', DEFAULT_OPTIONS, 0).next?.warmUntil).toBe(6 * 3_600_000)
  expect(applyArgs('warm off', { engine: 'rules', warmUntil: 5 }, 0).next?.warmUntil).toBe(0)
  expect(applyArgs('warm soon', DEFAULT_OPTIONS, 0).next).toBe(null)
})

// Keep-warm on the mock clock: the ping goes out after 50 idle minutes, and a failed one closes the window
async function warmWorld($: any, on: On, answers: boolean[]) {
  const clock = world(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1
    const ok = answers.shift() ?? true
    return { value: (ok
      ? { isAnswered: true as const, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 } }
      : { isAnswered: false as const, reason: 'api-error' as const, status: 500 }) as never }
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clauderouter', args: 'warm 3h', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 300, answer: '' })
  return { clock, forks: () => forks }
}

const MIN = 60_000
// advance() refuses a jump of more than 10000 timer waits, and the 100 ms frame timer fires all the while: go in 10-minute steps
async function idle(clock: { advance: (ms: number) => Promise<void> }, minutes: number) {
  for (let left = minutes; left > 0; left -= 10) await clock.advance(Math.min(left, 10) * MIN)
}

test('keep-warm pings the cache after 50 idle minutes, then every 50 more', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks } = await warmWorld($, on, [])
  await idle(clock, 40)
  expect(forks()).toBe(0)
  await idle(clock, 11)
  expect(forks()).toBe(1)
  await idle(clock, 30)
  expect(forks()).toBe(1)
  await idle(clock, 21)
  expect(forks()).toBe(2)
})

test('a failed ping closes the keep-warm window', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks } = await warmWorld($, on, [false])
  await idle(clock, 51)
  expect(forks()).toBe(1)
  await idle(clock, 120)
  expect(forks()).toBe(1)
})

test('keep-warm off sends no ping', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, forks } = await warmWorld($, on, [])
  await $.command.run({ command: 'clauderouter', args: 'warm off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await idle(clock, 120)
  expect(forks()).toBe(0)
})

test('Jev reports the tokens of its call for the context bar', async () => {
  const pick = await askJev(ok({ answers: { route: { choice: 'sonnet', probabilities: { sonnet: 0.7 } } }, usage: { input_tokens: 865, output_tokens: 162 } }), 'k', INPUT)
  expect(pick).toMatchObject({ model: 'sonnet', input: 865, output: 162 })
})

test('with the Jev engine the band lights jev and draws its context bar', async ($, on) => {
  world(on)
  on('env.get', () => ({ value: 'key' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { route: { choice: 'opus', probabilities: { opus: 0.9 } } }, usage: { input_tokens: 16000, output_tokens: 160 } }) } }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'clauderouter', args: 'engine jev', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 })) { /* drain */ }
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', requestId: 'band', props: BAND })
  expect((await band.find({ type: 'Text', text: /Jev · context/ }))).toBeTruthy()
  expect((await band.find({ type: 'Text', text: /16k \/ 64k · 25% · 1 calls/ }))).toBeTruthy()
  await band.unmount()
})
