import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { applyArgs, DEFAULT_OPTIONS, describe, normalize } from '../hooks/options'
import { fromJsonl, launchLine, taskLine, workflowLine } from '../hooks/sessionlog'
import { managerVerdict } from '../hooks/guard'

// Ultracode support: detection and advice only. The mod never turns ultracode on.

const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const HOME = 'C:/Users/me'
const WHO = { model: 'router' as const, effort: 'router' as const }

function world(on: On) {
  const written: Record<string, string> = {}
  const spawned: (string | undefined)[] = []
  mock.clock(on, { now: Date.UTC(2026, 10, 18, 9, 30) })
  mock.env(on, { USERPROFILE: HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('fs.write', (_$, e) => { written[e.path.split('\\').join('/')] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$, e) => { spawned.push(e.model); return { model: e.model ?? 'claude-opus-5-5', agentId: `a${spawned.length}` } })
  return { written, spawned }
}

const logOf = (written: Record<string, string>) => {
  const path = Object.keys(written).find(p => p.endsWith('.jsonl'))
  return path ? fromJsonl(written[path] ?? '') : []
}

const WF_SPAWN = { tool_use_id: 'w1', prompt: 'write the tests for the login flow', description: 'write tests', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: '', background: true, fork: false }

test('ultracode options: defaults, normalize and parsing', () => {
  expect(DEFAULT_OPTIONS).toMatchObject({ ultracode: 'advise', ultraMax: 5 })
  expect(normalize({ mode: 'claude' } as never)).toMatchObject({ ultracode: 'advise', ultraMax: 5 })
  expect(applyArgs('ultracode off', DEFAULT_OPTIONS, 0).next).toMatchObject({ ultracode: 'off', ultraMax: 5 })
  expect(applyArgs('ultracode advise', { ...DEFAULT_OPTIONS, ultracode: 'off' }, 0).next?.ultracode).toBe('advise')
  expect(applyArgs('ultracode max=8', DEFAULT_OPTIONS, 0).next).toMatchObject({ ultracode: 'advise', ultraMax: 8 })
  expect(applyArgs('ultracode off max=2', DEFAULT_OPTIONS, 0).next).toMatchObject({ ultracode: 'off', ultraMax: 2 })
  expect(applyArgs('ultracode on', DEFAULT_OPTIONS, 0).next).toBeNull()
  expect(applyArgs('ultracode max=0', DEFAULT_OPTIONS, 0).next).toBeNull()
  expect(applyArgs('ultracode', DEFAULT_OPTIONS, 0).next).toBeNull()
  expect(describe(DEFAULT_OPTIONS, 0)).toContain('ultracode: advise (warn above 5 workflow agents)')
})

test('log lines: ultra on the task, wf on the launch, a workflow line with the name only', () => {
  expect(taskLine(1, 1, 'use ultracode here', 'off', true)).toMatchObject({ t: 'task', ultra: true })
  expect(taskLine(1, 1, 'plain', 'off')).not.toHaveProperty('ultra')
  expect(taskLine(1, 1, 'x'.repeat(300), 'off', true).text).toHaveLength(120)
  const base = { id: 'a1', type: 'workflow-subagent', model: 'claude-sonnet-5-5', effort: null, by: WHO, brief: 'x', skills: [] }
  expect(launchLine(1, 1, { ...base, wf: 'audit' })).toMatchObject({ wf: 'audit' })
  expect(launchLine(1, 1, base)).not.toHaveProperty('wf')
  expect(workflowLine(1, 2, 'audit')).toMatchObject({ t: 'workflow', n: 2, name: 'audit' })
  expect(workflowLine(1, 2, null)).toMatchObject({ t: 'workflow', name: '' })
  expect((workflowLine(1, 2, 'n'.repeat(200)).name as string).length).toBe(60)
})

test('the guard refusal mentions a Workflow for people who opted into ultracode', () => {
  const v = managerVerdict('Bash', { command: 'ls' }, { home: HOME })
  expect(v?.message).toContain('or, if the person opted into ultracode, a Workflow')
  expect(managerVerdict('Workflow', {}, { home: HOME })).toBeNull()
})

test('keyword on a task is logged; a Workflow call and its agents carry the name', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'Ultracode: audit the whole site' })
  await $.tool.call({ tool: 'Workflow', meta: { name: 'site-audit' }, script: 'SECRETSCRIPT' } as never)
  await $.agent.spawn({ ...WF_SPAWN, parentModel: 'claude-sonnet-5-5' })
  await $.turn.start({ turnId: 't2', text: 'now something else' })
  await $.agent.spawn({ ...WF_SPAWN, tool_use_id: 'w2', subagentType: 'coder', parentModel: 'claude-sonnet-5-5' })
  const lines = logOf(written)
  expect(lines.filter(l => l.t === 'task').map(l => l.ultra)).toEqual([true, undefined])
  expect(lines.find(l => l.t === 'workflow')).toMatchObject({ name: 'site-audit', n: 1 })
  const agents = lines.filter(l => l.t === 'agent')
  expect(agents[0]).toMatchObject({ wf: 'site-audit' })
  expect(agents[1]).not.toHaveProperty('wf')
  expect(JSON.stringify(lines)).not.toContain('SECRETSCRIPT')
})

test('a workflow-subagent with no parentModel on an Opus session gets Sonnet in router mode', async ($, on) => {
  const { spawned } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  await $.agent.spawn({ ...WF_SPAWN })
  expect(spawned[0]).toBe('sonnet')
})

test('a workflow-subagent that names its model keeps it', async ($, on) => {
  const { spawned } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  await $.agent.spawn({ ...WF_SPAWN, model: 'claude-opus-5-5' })
  expect(spawned[0]).toBe('claude-opus-5-5')
})

test('claude mode passes a workflow-subagent through unchanged', async ($, on) => {
  const { spawned } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-mode', args: 'claude', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  await $.agent.spawn({ ...WF_SPAWN })
  expect(spawned[0]).toBeUndefined()
})
