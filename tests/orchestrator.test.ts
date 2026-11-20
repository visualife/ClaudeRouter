import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import type { Agent, Task } from '../types'
import { agentShare, promptShare } from '../hooks/pane'
import { applyArgs, DEFAULT_OPTIONS } from '../hooks/options'
import { agentDirs, ancestors, byText, costOf, deckText, fmtUsd, mergePrices, moneyText, deckCost, parsePrices, pricesEmpty, effortForHeld, envFacts, envWarnings, findFront, isBuiltin, parseFrontmatter, whoSets } from '../hooks/orchestrate'

// 0.5.0: orchestrator mode. A model or effort set by an agent file or by the Agent call is passed through unchanged;
// the router routes only what nobody set. The deck says who set what, and the tokens in and out.

const PLUGIN = 'agent-ClaudeRouter'
const SCROLL = { offset: 0, bodyRows: 40 }
const PANE = { title: 'ClaudeRouter', isFocused: false, bodyColumns: 140, placement: 'inline' as const, scroll: SCROLL, view: {} }
const USAGE = { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0.01 } }
const HOME = 'C:/Users/me'
const CWD = 'C:/work/site'
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

const file = (name: string, model?: string, effort?: string) =>
  ['---', `name: ${name}`, 'description: test agent', ...(model ? [`model: ${model}`] : []), ...(effort ? [`effort: ${effort}`] : []), '---', 'body'].join('\n')

// The agent files that exist, by absolute path
const FILES: Record<string, string> = {
  [`${HOME}/.claude/agents/coder.md`]: file('coder', 'sonnet', 'medium'),
  [`${HOME}/.claude/agents/art-copy.md`]: file('art-copy', 'opus', 'xhigh'),
  [`${HOME}/.claude/agents/modelonly.md`]: file('modelonly', 'opus'),
  [`${HOME}/.claude/agents/effortonly.md`]: file('effortonly', undefined, 'high'),
  [`${HOME}/.claude/agents/plain.md`]: file('plain'),
  [`${HOME}/.claude/orchestrator.md`]: '# Orchestrator rules\nYou manage. You never read code.\n',
}

type Spawned = { model?: string }

// The engine's side: what a real session answers beneath the plugin. fs.read answers from FILES; a path not in it rejects.
function world(on: On, vars: Record<string, string> = {}) {
  const seen = { spawned: [] as Spawned[], toasts: [] as string[], sent: [] as string[], reads: [] as string[], callIds: [] as string[] }
  mock.clock(on)
  mock.env(on, { USERPROFILE: HOME, ...vars })
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    // the engine hands a hook the path in the platform's spelling
    const text = FILES[e.path.split('\\').join('/')]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  // every request of the plugin ends here: what reaches the engine is what the plugin sent
  on('turn.step', async function* (_$, e) {
    seen.sent.push(`${e.model}/${e.effort}`)
    return STEP_DONE(e)
  })
  on('fs.list', () => ({ value: [] }))
  // $.tool.call mints its own tool_use_id: the spawn that follows a call carries the same one
  on('tool.call', (_$, e) => {
    seen.callIds.push(e.tool_use_id)
    return { result: 'started' }
  })
  on('agent.spawn', (_$, e) => {
    seen.spawned.push({ model: e.model })
    return { model: e.model ?? 'inherited', agentId: 'a1' }
  })
  return seen
}

const SPAWN = {
  tool_use_id: 'u1',
  prompt: 'list the files under src',
  description: 'list files',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-fable-5-2',
  background: true,
  fork: false,
}

const STEP_DONE = (e: { turnId: string; index: number }) => ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null })

// Runs one subagent request through the plugin and returns what reached the engine as "model/effort"
async function stepOf($: Engine, seen: { sent: string[] }, engine: { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }) {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, agentId: 'a1', model: engine.model, ...(engine.effort ? { effort: engine.effort } : {}), messageCount: 1 })) { /* drain */ }
  return seen.sent.at(-1)
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────────

test('frontmatter: model, effort and name are read; quotes, comments and nested keys are not mistaken for them', () => {
  expect(parseFrontmatter('---\nname: coder\nmodel: sonnet\neffort: medium\ntools: Read, Edit\n---\nbody')).toEqual({ name: 'coder', model: 'sonnet', effort: 'medium' })
  expect(parseFrontmatter('---\r\nname: "scout"\r\nmodel: \'haiku\'  # cheap\r\n---\r\n')).toEqual({ name: 'scout', model: 'haiku' })
  expect(parseFrontmatter('---\nname: x\nhooks:\n  model: opus\n---\n')).toEqual({ name: 'x' })
  expect(parseFrontmatter('model: opus\nno fence')).toEqual({})
  // a "model:" after the closing fence is the body
  expect(parseFrontmatter('---\nname: x\n---\nmodel: opus')).toEqual({ name: 'x' })
})

test('who sets a spawn: env, then the Agent call, then the file; the router only when nobody did', () => {
  const base = { front: {}, builtin: false, fork: false, envModel: false, envEffort: false }
  expect(whoSets({ ...base, builtin: true })).toEqual({ model: 'router', effort: 'router' })
  expect(whoSets({ ...base, front: { model: 'sonnet', effort: 'medium' } })).toEqual({ model: 'frontmatter', effort: 'frontmatter' })
  expect(whoSets({ ...base, front: { model: 'sonnet' }, callModel: 'opus', callEffort: 'high' })).toEqual({ model: 'orchestrator', effort: 'orchestrator' })
  // a file that sets the model only leaves the effort to the router
  expect(whoSets({ ...base, front: { model: 'opus' } })).toEqual({ model: 'frontmatter', effort: 'router' })
  // an environment override beats both
  expect(whoSets({ ...base, front: { model: 'sonnet' }, callModel: 'opus', envModel: true, envEffort: true })).toEqual({ model: 'env', effort: 'env' })
  // a definition the router could not read, and a fork: left to the engine
  expect(whoSets({ ...base, front: null })).toEqual({ model: 'default', effort: 'default' })
  expect(whoSets({ ...base, front: null, builtin: true })).toEqual({ model: 'router', effort: 'router' })
  expect(whoSets({ ...base, fork: true, callModel: 'opus' })).toEqual({ model: 'default', effort: 'default' })
  // a call that names the effort of an agent whose file cannot be read still counts
  expect(whoSets({ ...base, front: null, callEffort: 'low' })).toEqual({ model: 'default', effort: 'orchestrator' })
  expect(isBuiltin('Explore')).toBe(true)
  expect(isBuiltin('coder')).toBe(false)
})

test('agent files are found by name, by scoped path and by the name in their frontmatter', async () => {
  const files: Record<string, string> = {
    '/p/.claude/agents/review/audit.md': file('auditor', 'haiku'),
    '/u/.claude/agents/coder.md': file('coder', 'sonnet', 'medium'),
    '/plug/agents/sub/deep.md': file('deep', 'opus', 'high'),
  }
  const dirs: Record<string, { name: string; kind: string }[]> = {
    '/p/.claude/agents': [{ name: 'review', kind: 'dir' }],
    '/p/.claude/agents/review': [{ name: 'audit.md', kind: 'file' }],
  }
  const io = {
    read: async (path: string) => files[path] ?? null,
    list: async (path: string) => dirs[path] ?? [],
  }
  expect(await findFront('coder', ['/p/.claude/agents', '/u/.claude/agents'], io)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  // a file whose name differs from its frontmatter name, in a subfolder
  expect(await findFront('auditor', ['/p/.claude/agents'], io)).toMatchObject({ model: 'haiku' })
  // a plugin's "plugin:sub:name" is sub/name.md under its agents folder
  expect(await findFront('plug:sub:deep', ['/plug/agents'], io)).toMatchObject({ model: 'opus', effort: 'high' })
  expect(await findFront('plug:missing', ['/plug/agents'], io)).toBeNull()
  expect(await findFront('nobody', ['/p/.claude/agents', '/u/.claude/agents'], io)).toBeNull()
})

test('the project folder is searched first, with its parents, then the user folder', () => {
  expect(ancestors('C:/work/site', 2)).toEqual(['C:/work/site', 'C:/work'])
  expect(agentDirs('C:\\work\\site', 'C:\\Users\\me').slice(0, 2)).toEqual(['C:/work/site/.claude/agents', 'C:/work/.claude/agents'])
  expect(agentDirs('C:/work/site', 'C:\\Users\\me').at(-1)).toBe('C:/Users/me/.claude/agents')
  expect(agentDirs('/home/me/p', undefined)).toContain('/home/me/p/.claude/agents')
})

test('environment overrides: FORCE and an effort level are warned about; auto, unset and off are not', () => {
  expect(envWarnings(envFacts({}))).toEqual([])
  expect(envWarnings(envFacts({ force: '0', effort: 'auto' }))).toEqual([])
  expect(envWarnings(envFacts({ force: 'false', effort: 'unset' }))).toEqual([])
  const both = envWarnings(envFacts({ force: '1', model: 'haiku', effort: 'high' }))
  expect(both).toHaveLength(2)
  expect(both[0]).toMatch(/SUBAGENT_MODEL_FORCE.*haiku/)
  expect(both[1]).toMatch(/EFFORT_LEVEL=high/)
  // CLAUDE_CODE_SUBAGENT_MODEL alone is only a default, not an override
  expect(envWarnings(envFacts({ model: 'haiku' }))).toEqual([])
})

test('a model set by someone else gets the router\'s effort, held to medium unless the agent plans', () => {
  expect(effortForHeld('opus', 'list the files', 'coder', 'high')).toBe('medium')
  expect(effortForHeld('opus', 'plan the migration', 'architect', 'high')).toBe('high')
  expect(effortForHeld('haiku', 'list the files', 'scout', 'high')).toBe('low')
  expect(byText({ model: 'frontmatter', effort: 'frontmatter' })).toBe('frontmatter')
  expect(byText({ model: 'frontmatter', effort: 'router' })).toBe('model frontmatter · effort router')
})

test('orchestrator is on by default, and /cr-orchestrator turns it on and off', () => {
  expect(DEFAULT_OPTIONS.orchestrator).toBe('on')
  expect(applyArgs('orchestrator on', { ...DEFAULT_OPTIONS, orchestrator: 'off' }, 0).next?.orchestrator).toBe('on')
  expect(applyArgs('orchestrator off', { ...DEFAULT_OPTIONS, orchestrator: 'on' }, 0).next?.orchestrator).toBe('off')
  expect(applyArgs('orchestrator maybe', DEFAULT_OPTIONS, 0).next).toBeNull()
  expect(applyArgs('status', { ...DEFAULT_OPTIONS, orchestrator: 'on' }, 0).text).toMatch(/orchestrator: on/)
})

// ── Pass-through ────────────────────────────────────────────────────────────────────────────────────────────

test('an agent file\'s model and effort pass through unchanged, even where the router would pick lower', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  // "list the files" would be Haiku at low for the router
  await $.agent.spawn({ ...SPAWN, subagentType: 'art-copy' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(await stepOf($, seen, { model: 'claude-opus-5-5', effort: 'xhigh' })).toBe('claude-opus-5-5/xhigh')
})

test('a model named by the Agent call passes through unchanged', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'coder', model: 'opus' })
  // the call outranks the file's sonnet
  expect(seen.spawned[0]?.model).toBe('opus')
  expect(await stepOf($, seen, { model: 'claude-opus-5-5', effort: 'medium' })).toBe('claude-opus-5-5/medium')
})

test('an effort named by the Agent call passes through unchanged, above the file and the router', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  // the call raised by the orchestrator (an agent with no effort of its own), then the spawn it led to
  await $.tool.call({ tool: 'Agent', description: 'list files', prompt: SPAWN.prompt, subagent_type: 'plain', effort: 'max' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: seen.callIds[0] ?? 'missing', subagentType: 'plain', parentModel: 'claude-sonnet-5-5' })
  // the router still picks the model (Haiku for "list the files"), but the effort the call set goes out as it is
  expect(seen.spawned[0]?.model).toBe('haiku')
  expect(await stepOf($, seen, { model: 'claude-haiku-5-5', effort: 'max' })).toBe('claude-haiku-5-5/max')
})

test('without an effort on the call, the same agent gets the effort the router picks', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'plain', parentModel: 'claude-sonnet-5-5' })
  expect(await stepOf($, seen, { model: 'claude-haiku-5-5', effort: 'max' })).toBe('claude-haiku-5-5/low')
})

test('a model set and no effort: the model is untouched and the router picks the effort for it', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'modelonly' })
  // Opus by the file; "list the files" earns medium, never the guard's switch to Sonnet
  expect(await stepOf($, seen, { model: 'claude-opus-5-5', effort: 'high' })).toBe('claude-opus-5-5/medium')
})

test('an effort set and no model: the router picks the model and the effort stays', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'effortonly', parentModel: 'claude-sonnet-5-5' })
  // routed at spawn: "list the files" is Haiku
  expect(seen.spawned[0]?.model).toBe('haiku')
  expect(await stepOf($, seen, { model: 'claude-haiku-5-5', effort: 'high' })).toBe('claude-haiku-5-5/high')
})

// ── The routed default ──────────────────────────────────────────────────────────────────────────────────────

test('a built-in agent that nothing sets is routed: Explore to Haiku at low', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'map the routes' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', prompt: 'find where the routes are defined', description: 'Map the routes', parentModel: 'claude-sonnet-5-5' })
  expect(seen.spawned[0]?.model).toBe('haiku')
  expect(await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'medium' })).toBe('claude-haiku-5-5/low')
})

test('an agent whose file has no model or effort is routed', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'plain', prompt: 'write the tests for the login flow', description: 'write tests', parentModel: 'claude-sonnet-5-5' })
  expect(seen.spawned[0]?.model).toBe('sonnet')
  expect(await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'high' })).toBe('claude-sonnet-5-5/medium')
})

test('an agent whose definition cannot be read is left to the engine, not routed over a choice the router cannot see', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'stranger', parentModel: 'claude-sonnet-5-5' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'high' })).toBe('claude-sonnet-5-5/high')
})

// ── Orchestrator mode ───────────────────────────────────────────────────────────────────────────────────────

test('orchestrator on: the main model is never rerouted; off, it is', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  // on is the default: this test starts from off
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  const heavy = 'plan the architecture and debug the token check across modules'
  await $.turn.start({ turnId: 't1', text: heavy })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 1, answer: '' })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't2', text: heavy })
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })) { /* drain */ }
  expect(seen.sent).toEqual(['claude-opus-5-5/high', 'claude-sonnet-5-5/medium'])
})

test('under a locked parent a sub-agent nothing sets inherits it; with the orchestrator on it is routed', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  const brief = { ...SPAWN, subagentType: 'general-purpose', prompt: 'write the tests for the login flow', description: 'write tests', parentModel: 'claude-fable-5-2' }
  await $.agent.spawn(brief)
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.agent.spawn({ ...brief, tool_use_id: 'u2' })
  expect(seen.spawned.map(s => s.model)).toEqual(['claude-fable-5-2', 'sonnet'])
})

test('with the orchestrator on, what the file or the call set still wins over the router', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'art-copy' })
  expect(seen.spawned[0]?.model).toBeUndefined()
  expect(await stepOf($, seen, { model: 'claude-opus-5-5', effort: 'xhigh' })).toBe('claude-opus-5-5/xhigh')
})

// ── Warnings and the deck ───────────────────────────────────────────────────────────────────────────────────

test('session start warns when an environment variable overrides every choice, and the pane keeps the warning', async ($, on) => {
  const seen = world(on, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'high' })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(seen.toasts).toHaveLength(2)
  expect(seen.toasts[0]).toMatch(/SUBAGENT_MODEL_FORCE/)
  expect(seen.toasts[1]).toMatch(/EFFORT_LEVEL=high/)
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect(await pane.find({ type: 'Text', text: /⚠ CLAUDE_CODE_SUBAGENT_MODEL_FORCE/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /⚠ CLAUDE_CODE_EFFORT_LEVEL=high/ })).toBeTruthy()
  await pane.unmount()
})

test('no warning when neither variable is set', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(seen.toasts).toEqual([])
})

test('with an override set, the deck says env set the model and the effort', async ($, on) => {
  const seen = world(on, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'coder', model: 'opus' })
  // the engine ignores the call's model under FORCE; the router leaves the request as it is
  expect(seen.spawned[0]?.model).toBe('opus')
  expect(await stepOf($, seen, { model: 'claude-haiku-5-5', effort: 'low' })).toBe('claude-haiku-5-5/low')
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE })
  expect(await pane.find({ type: 'Text', text: /set by env/ })).toBeTruthy()
  await pane.unmount()
})

test('the deck shows each sub-agent: name, model, effort, who set them, and tokens in and out', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.tool.call({ tool: 'Agent', description: 'list files', prompt: SPAWN.prompt, subagent_type: 'coder', effort: 'high' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: seen.callIds[0] ?? 'missing', subagentType: 'coder' })
  await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'high' })
  await $.turn.complete({
    turnId: 't1', agentId: 'a1', reason: 'answer', isAborted: false, durationMs: 4000, answer: 'done',
    usage: { input_tokens: 2000, output_tokens: 1200, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 80_000, model: 'claude-sonnet-5-5' },
  })
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE })
  // name and type
  expect(await pane.find({ type: 'Text', text: /coder · list files/ })).toBeTruthy()
  // model, effort and state
  expect(await pane.find({ type: 'Text', text: /sonnet · high · done/ })).toBeTruthy()
  // model by the file, effort by the Agent call
  expect(await pane.find({ type: 'Text', text: /set by model frontmatter · effort orchestrator/ })).toBeTruthy()
  // in = input + cache writes, then the cache reads, then out
  expect(await pane.find({ type: 'Text', text: /in 12k \+ 80k cached · out 1\.2k/ })).toBeTruthy()
  await pane.unmount()
})

test('/cr-deck prints the deck as text with exact figures, and a total', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'cr-deck', args: '', ...CMD })).text).toBe('No task yet.')
  await $.turn.start({ turnId: 't1', text: 'split the task' })
  await $.tool.call({ tool: 'Agent', description: 'list files', prompt: SPAWN.prompt, subagent_type: 'coder', effort: 'high' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: seen.callIds[0] ?? 'missing', subagentType: 'coder' })
  await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'high' })
  await $.turn.complete({
    turnId: 't1', agentId: 'a1', reason: 'answer', isAborted: false, durationMs: 4000, answer: 'done',
    usage: { input_tokens: 2000, output_tokens: 1200, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 80_000, model: 'claude-sonnet-5-5' },
  })
  await $.turn.complete({
    turnId: 't1', reason: 'answer', isAborted: false, durationMs: 9000, answer: 'all done',
    usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 4000, cache_read_input_tokens: 20_000, model: 'claude-fable-5-2' },
  })
  const text = (await $.command.run({ command: 'cr-deck', args: '', ...CMD })).text ?? ''
  const lines = text.split(/\r?\n/)
  expect(lines[0]).toMatch(/^task · split the task · .* · done · in 4500 · cached 20000 · out 300 · prices missing · 0:09$/)
  expect(lines[1]).toMatch(/^ {2}⇄ main in\+out 4800 \(27%\) · agents in\+out 13200 \(73%\) · cost main prices missing · agents prices missing · guard blocks 0$/)
  expect(lines[2]).toBe('  └ coder · list files · sonnet · high · set by model frontmatter · effort orchestrator · done · in 12000 · cached 80000 · out 1200 · prices missing · 0:04')
  expect(lines[3]).toBe('total · in 16500 · cached 100000 · out 1500 · in+out 18000 · cost prices missing')
})

test('a sub-agent run and a hand-back are not tasks: the deck keeps one row per prompt, with every turn of it added up', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'list the hash checks' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'coder' })
  // the sub-agent's own run starts with its brief
  await $.turn.start({ turnId: 'ta', agentId: 'a1', text: 'Read-only. Do not edit anything.' })
  await stepOf($, seen, { model: 'claude-sonnet-5-5', effort: 'medium' })
  await $.turn.complete({ turnId: 'ta', agentId: 'a1', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'x', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' } })
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 2000, answer: '', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, model: 'm' } })
  // the hand-back wakes the main loop
  await $.turn.start({ turnId: 't2', text: '<~agent-message from="a1"> [Subagent hand-back] done' })
  await $.turn.complete({ turnId: 't2', reason: 'answer', isAborted: false, durationMs: 3000, answer: '', usage: { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, model: 'm' } })
  const lines = ((await $.command.run({ command: 'cr-deck', args: '', ...CMD })).text ?? '').split(/\r?\n/)
  expect(lines).toHaveLength(4)
  expect(lines[0]).toMatch(/^task · list the hash checks · .* · done · in 120 · cached 3000 · out 57 · prices missing · 0:05$/)
  expect(lines[2]).toMatch(/^ {2}└ coder .* in 10 · cached 0 · out 5/)
  expect(lines[3]).toBe('total · in 130 · cached 3000 · out 62 · in+out 192 · cost prices missing')
})

test('a resumed agent is the same deck row, not a second one', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'write the table' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'coder' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u2', subagentType: 'coder', resume: { agentId: 'a1' } })
  expect(seen.spawned).toHaveLength(2)
  const lines = ((await $.command.run({ command: 'cr-deck', args: '', ...CMD })).text ?? '').split(/\r?\n/)
  expect(lines.filter(l => l.includes('└'))).toHaveLength(1)
})

// ── Prices ──────────────────────────────────────────────────────────────────────────────────────────────────

const FULL = parsePrices(JSON.stringify({ models: { sonnet: { input: 3, output: 15, cacheWrite: 4, cacheRead: 0.5 }, haiku: { input: 1, output: 5, cacheWrite: null, cacheRead: 0.1 } } }))

test('an empty table, a broken file and bad numbers are never turned into a price', () => {
  const shipped = parsePrices('{"models":{"sonnet":{"input":null,"output":null,"cacheWrite":null,"cacheRead":null}}}')
  expect(pricesEmpty(shipped)).toBe(true)
  expect(pricesEmpty(parsePrices('not json'))).toBe(true)
  expect(pricesEmpty(parsePrices('{"models":{"sonnet":{"input":"3","output":-1}}}'))).toBe(true)
  expect(costOf('claude-sonnet-5-5', { tokensIn: 1000, tokensOut: 10 }, shipped)).toBeNull()
  expect(fmtUsd(null)).toBe('prices missing')
})

test('cost is per model: fresh input, cache writes, cache reads and output at their own prices', () => {
  // 1M fresh input, 1M cache writes, 1M cache reads, 1M output on sonnet
  const usd = costOf('claude-sonnet-5-5', { tokensIn: 2_000_000, tokensWrite: 1_000_000, tokensCached: 1_000_000, tokensOut: 1_000_000 }, FULL)
  expect(Math.round((usd ?? 0) * 1e6) / 1e6).toBe(22.5)
  // a model with a price missing for a kind of token the row used
  expect(costOf('claude-haiku-5-5', { tokensIn: 100, tokensWrite: 100 }, FULL)).toBeNull()
  // ...but not for one it did not use
  expect(Math.round(costOf('claude-haiku-5-5', { tokensIn: 1_000_000, tokensOut: 0 }, FULL)! * 1e6) / 1e6).toBe(1)
  // a row with no tokens costs nothing even where the table is empty
  expect(costOf('claude-fable-5-2', {}, FULL)).toBe(0)
  expect(costOf('claude-fable-5-2', { tokensOut: 5 }, FULL)).toBeNull()
})

test('a user file overrides the shipped one only where it has a number', () => {
  const merged = mergePrices(FULL, parsePrices('{"models":{"sonnet":{"input":6}}}'))
  expect(merged.sonnet).toEqual({ input: 6, output: 15, cacheWrite: 4, cacheRead: 0.5 })
  expect(merged.opus).toEqual({ input: null, output: null, cacheWrite: null, cacheRead: null })
})

test('the deck says "prices missing" for an empty table and shows cost per row and in total once filled', () => {
  const tasks = [{
    id: 't', name: 'job', status: 'done' as const, startedAt: 0, seconds: 10, steps: 1, model: 'sonnet' as const, effort: 'medium' as const,
    tokens: 0, tokensIn: 1_000_000, tokensWrite: 0, tokensCached: 0, tokensOut: 0,
    agents: [{ id: 'a', name: 'x', type: 'scout', role: 'scout' as const, model: 'haiku', effort: 'low' as const, status: 'done' as const, startedAt: 0, seconds: 1, tokens: 0, tokensIn: 1_000_000, tokensWrite: 0, tokensCached: 0, tokensOut: 0, by: { model: 'frontmatter' as const, effort: 'frontmatter' as const } }],
  }]
  expect(deckText(tasks, {})).toMatch(/cost prices missing$/)
  const text = deckText(tasks, FULL)
  expect(text).toMatch(/\$3\.00 · 0:10/)
  expect(text).toMatch(/\$1\.00 · 0:01/)
  expect(text).toMatch(/cost \$4\.00$/)
  // one model missing: the known part and the count of rows that lack a price
  expect(moneyText(deckCost(tasks, parsePrices('{"models":{"sonnet":{"input":3}}}')))).toBe('$3.00 + prices missing for 1 of 2 rows')
})

// ── Manager guard ───────────────────────────────────────────────────────────────────────────────────────────

const EDIT = { tool: 'Edit' as const, file_path: 'C:/work/site/src/app.ts', old_string: 'a', new_string: 'b' }

test('rules: turning the orchestrator on loads them into the main session and says how big they are', async ($, on) => {
  const seen = world(on)
  const session = mock.session(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const said = (await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })).text ?? ''
  expect(said).toMatch(/^orchestrator: on · manager only · rules loaded \(\d+ B\)$/)
  const rows = session.appended()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows[0]?.message)).toMatch(/orchestrator-rules.*You manage/)
  // never into a sub-agent's conversation
  expect(rows[0]?.agentId).toBeUndefined()
  // /cr-status shows the mode and whether the rules are loaded
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text).toMatch(/orchestrator: on \(manager only\) · rules loaded \(\d+ B\)/)
  // on to hands on does not load them twice
  expect((await $.command.run({ command: 'cr-orchestrator', args: 'hands on', ...CMD })).text).toMatch(/^orchestrator: hands on · guard off · rules loaded/)
  expect(session.appended()).toHaveLength(1)
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text).toMatch(/orchestrator: hands on \(guard off\)/)
  expect(seen.spawned).toHaveLength(0)
})

test('rules: a missing rules file is said, not confirmed, and the mode stays off', async ($, on) => {
  world(on)
  delete FILES[`${HOME}/.claude/orchestrator.md`]
  try {
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    const said = (await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })).text ?? ''
    expect(said).toMatch(/^orchestrator not turned on: the rules file is missing or empty: .*orchestrator\.md/)
    expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text).toMatch(/orchestrator: off · rules not loaded/)
  } finally {
    FILES[`${HOME}/.claude/orchestrator.md`] = '# Orchestrator rules\nYou manage. You never read code.\n'
  }
})

test('guard: with the orchestrator on, the main thread cannot Edit or run Bash, and the refusal names the agent to use', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'do the task' })
  const edit = await $.tool.call(EDIT)
  expect(edit.deny).toMatch(/Edit on C:\/work\/site\/src\/app\.ts is blocked.*subagent_type "coder"/)
  const bash = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(bash.deny).toMatch(/Bash is blocked.*subagent_type "test-runner"/)
  const read = await $.tool.call({ tool: 'Read', file_path: 'C:/work/site/src/app.ts' })
  expect(read.deny).toMatch(/subagent_type "scout"/)
  // the way out is named, and the map of agents is in every refusal
  expect(edit.deny).toMatch(/reading → scout, change → coder, design or contract → architect, design and copy → art-copy, tests → test-runner, judging → verifier/)
  // the deck counts the refusals
  const deck = (await $.command.run({ command: 'cr-deck', args: '', ...CMD })).text ?? ''
  expect(deck).toMatch(/guard blocks 3/)
})

test('guard: HANDOFF.md, MAP.md, plans and the rules are allowed; the Agent tool is never blocked', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'do the task' })
  expect((await $.tool.call({ ...EDIT, file_path: 'C:\\work\\site\\HANDOFF.md' })).deny).toBeUndefined()
  expect((await $.tool.call({ ...EDIT, file_path: 'C:/work/site/old-handoff/HANDOFF-archive.md' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'C:/work/site/MAP.md' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/orchestrator.md` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y', subagent_type: 'scout' })).deny).toBeUndefined()
})

test('guard: a sub-agent is never blocked', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'do the task' })
  expect((await $.tool.call({ ...EDIT, agentId: 'a1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })).deny).toBeUndefined()
})

test('guard: nothing is blocked when the orchestrator is off or hands on', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'do the task' })
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
  await $.command.run({ command: 'cr-orchestrator', args: 'hands on', ...CMD })
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).deny).toBeUndefined()
  // on blocks, off lifts it at once
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  expect((await $.tool.call(EDIT)).deny).toBeDefined()
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
})

test('the deck puts the main thread against its sub-agents and shows hands on in amber', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'hands on', ...CMD })
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 30, bodyColumns: 100, scroll: SCROLL, view: {} } })
  expect(await band.find({ type: 'Text', text: /HANDS ON \(guard off\)/ })).toBeTruthy()
  await band.unmount()
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PANE })
  await $.turn.start({ turnId: 't1', text: 'do the task' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 1000, answer: '', usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' } })
  expect(await pane.find({ type: 'Text', text: /main in\+out 120 \(100%\) · agents in\+out 0 \(0%\)/ })).toBeTruthy()
  await pane.unmount()
})

test("pane row bars show the share of the prompt's tokens spent by sub-agents", () => {
  const agent = (over: Partial<Agent>): Agent => ({ id: 'a', name: 'x', type: 'coder', role: 'builder', model: 'sonnet', effort: 'high', status: 'done', startedAt: 0, seconds: 1, tokens: 0, ...over })
  const task = (over: Partial<Task>): Task => ({ id: 't', name: 'p', status: 'done', startedAt: 0, seconds: 1, steps: 0, model: 'opus', effort: 'high', tokens: 100, tokensIn: 60, tokensCached: 30, tokensOut: 10, agents: [], ...over })
  // main 100 tokens, one agent 300: the agent did 75% of the prompt's work
  const t = task({ agents: [agent({ tokensIn: 200, tokensCached: 80, tokensOut: 20 })] })
  expect(promptShare(t)).toBe(75)
  expect(agentShare(t, t.agents[0]!)).toBe(75)
  // two agents of 100 and 200 beside a main thread of 100
  const two = task({ agents: [agent({ tokensIn: 100 }), agent({ id: 'b', tokensIn: 200 })] })
  expect(promptShare(two)).toBe(75)
  expect(agentShare(two, two.agents[1]!)).toBe(50)
  // no agent: 0, not null
  expect(promptShare(task({}))).toBe(0)
  // a running agent has no tokens yet: no reading for its row
  expect(agentShare(task({ agents: [agent({ status: 'running' })] }), agent({ status: 'running' }))).toBeNull()
  // the main thread's figure is not in yet: no reading
  expect(promptShare(task({ status: 'running', tokens: null, tokensIn: undefined, tokensCached: undefined, tokensOut: undefined, agents: [agent({ tokensIn: 5 })] }))).toBeNull()
})
