import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { managerVerdict } from '../hooks/guard'
import { DEFAULT_OPTIONS, WARM_EVERY_MS } from '../hooks/options'
import { blockLine, commandWords, fromJsonl, launchLine, skillsNamed, stamp, toJsonl, verdictOf, warmLine } from '../hooks/sessionlog'

// Session-log hygiene, the manager guard's own-folder writes, the band's warnings, and the orchestrator default.

const HOME = 'C:/Users/me'
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const BAND = { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PLUGIN = 'agent-ClaudeRouter'
const WHO = { model: 'router' as const, effort: 'router' as const }
const SPAWN = { tool_use_id: 'u1', prompt: 'x', description: 'x', subagentType: 'verifier', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-fable-5-2', background: true, fork: false }
const FILES: Record<string, string> = {
  [`${HOME}/.claude/agents/verifier.md`]: '---\nname: verifier\nmodel: sonnet\neffort: high\nmaxTurns: 2\n---\nbody',
  [`${HOME}/.claude/orchestrator.md`]: '# Orchestrator rules\nYou manage.\n',
}

// sessionId null: $.session.id() fails
function world(on: On, files: Record<string, string> = FILES, sessionId: string | null = 'sess-1', appendThrows = false) {
  const written: Record<string, string> = {}
  const toasts: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 18, 9, 30) })
  mock.env(on, { USERPROFILE: HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (sessionId === null) throw new Error('no session id')
    return { value: sessionId }
  })
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId?: string }).sessionId ?? sessionId ?? 'session' }))
  const session = appendThrows ? { appended: () => [] as never[] } : mock.session(on)
  if (appendThrows) on('session.append', () => ({ deny: 'append refused' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => { toasts.push((e as { text: string }).text); return { value: undefined } })
  on('fs.read', (_$, e) => {
    const path = e.path.split('\\').join('/')
    const text = written[path] ?? files[path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => { written[e.path.split('\\').join('/')] = e.text; return { value: undefined } })
  on('fs.list', (_$, e) => {
    const dir = e.path.split('\\').join('/').replace(/\/+$/, '')
    return { value: Object.keys(written).filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: `a${Object.keys(written).length}${Math.random().toString(36).slice(2, 6)}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { written, session, toasts, clock }
}

const jsonls = (written: Record<string, string>) => Object.keys(written).filter(p => p.endsWith('.jsonl'))
const linesOf = (written: Record<string, string>, path?: string) => fromJsonl(written[path ?? jsonls(written)[0] ?? ''] ?? '')
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-sonnet-5-5' }

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────────────────

test('verdictOf: cut only when capped with no verdict line', () => {
  expect(verdictOf('ran out of turns', true)).toMatchObject({ verdict: 'cut', pass: 0, fail: 0, unchecked: 0 })
  expect(verdictOf('ran out of turns', false)).toMatchObject({ verdict: 'not checked' })
  expect(verdictOf('PASS a', true)).toMatchObject({ verdict: 'pass' })
  expect(verdictOf('NOT CHECKED a', true)).toMatchObject({ verdict: 'not checked' })
})

test('launchLine flags: verdictRule and skillsLine, with the 120 cut kept', () => {
  const base = { id: 'a', type: 'verifier', model: 'm', effort: null, by: WHO, skills: [] }
  const a = launchLine(0, 1, { ...base, brief: `${'z'.repeat(200)}\nSkills: seo\nAnswer with PASS, FAIL or NOT CHECKED lines` })
  expect(a).toMatchObject({ verdictRule: true, skillsLine: true })
  expect(String(a.brief)).toHaveLength(120)
  expect(launchLine(0, 1, { ...base, brief: 'plain\nSkill: x' })).toMatchObject({ verdictRule: false, skillsLine: true })
  expect(launchLine(0, 1, { ...base, brief: 'plain skills: in the middle' })).toMatchObject({ verdictRule: false, skillsLine: false })
})

test('skillsNamed refuses "skill:", "flow:" and prose, keeps plugin:skill and plain lists', () => {
  expect(skillsNamed('Skills: skill:')).toEqual([])
  expect(skillsNamed('Skills: flow:')).toEqual([])
  expect(skillsNamed('Skills: use whatever fits the job, then report back')).toEqual([])
  expect(skillsNamed('Skills: skill: use it')).toEqual([])
  expect(skillsNamed('Skills: impeccable, seo')).toEqual(['impeccable', 'seo'])
  expect(skillsNamed('Skills: n8n:using-n8n-mcp, seo')).toEqual(['n8n:using-n8n-mcp', 'seo'])
  expect(skillsNamed('Skills: Use n8n-mcp-skills:using-n8n-mcp-skills first')).toEqual(['n8n-mcp-skills:using-n8n-mcp-skills'])
})

test('blockLine for Bash keeps only the program and its plain subcommand', () => {
  const l = blockLine(0, 1, { tool: 'Bash', target: '', agent: 'test-runner', command: 'API_KEY=sk-abcdef1234567890 npm test -- --token ghp_abcdefghijklmnop1234 "Authorization: Bearer SECRETVALUE"' })
  expect(l.target).toBe('npm test')
  expect(String(blockLine(0, 1, { tool: 'Bash', target: '', agent: 't', command: `echo ${'a'.repeat(200)}` }).target)).toBe('echo')
  for (const [command, kept] of [
    ['gh auth login --with-token', 'gh auth'],
    ['git push origin main', 'git push'],
    ['curl https://u:pw@host/x?key=abc', 'curl'],
    ['npm run build', 'npm run'],
    ['/usr/local/bin/git status', 'git status'],
    ['C:\\tools\\git.exe push', 'git.exe'],
    ['git -C /secret/path push', 'git'],
    ['git Push', 'git'],
  ] as const) expect(commandWords(command)).toBe(kept)
})

test('commandWords: no secret text from the leak examples', () => {
  const leaks: [string, string[]][] = [
    ['curl -u user:pass https://example.com', ['user', 'pass']],
    ['curl --user a:b https://example.com', ['a:b']],
    ['ssh user:pass@host', ['user', 'pass', 'host']],
    ['mysql -pHUNTER2 shop', ['HUNTER2', 'shop']],
    ['mysql -p x', ['x']],
    ['cli --otp 123456', ['123456', 'otp']],
    ['$env:API_KEY = "abc123"', ['abc123', 'API_KEY']],
    ['set API_KEY = abc123', ['abc123', 'API_KEY']],
    ['set api_key abc123', ['abc123', 'api_key']],
    ['echo hunter2 | sudo -S apt update', ['hunter2', 'sudo', 'apt']],
    ['echo pw | sudo -S', ['pw', 'sudo']],
    ['printf pw | su', ['pw']],
    ['aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalr', 'K7MDENG', 'EXAMPLEKEY', 'secret']],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls', ['wJalr', 'K7MDENG', 'AWS_SECRET']],
    ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalr', 'EXAMPLEKEY']],
    ['"quoted secret" run', ['quoted', 'secret']],
    ['ls;cat /etc/secret', ['secret', 'cat']],
  ]
  for (const [command, secrets] of leaks) {
    const target = String(blockLine(0, 1, { tool: 'Bash', target: '', agent: 'test-runner', command }).target)
    for (const s of secrets) expect(target.includes(s)).toBe(false)
    // whatever comes out is a name and at most one lowercase word
    expect(target).toMatch(/^(?:[A-Za-z0-9][A-Za-z0-9._+-]{0,39}(?: [a-z][a-z0-9-]{0,20})?)?$/)
  }
  // only a name and at most one lowercase word ever come out
  expect(commandWords('echo pw | sudo -S')).toBe('echo')
  expect(commandWords('')).toBe('')
  expect(commandWords('   ')).toBe('')
})

test('blockLine for Bash: path targets and absent commands are untouched', () => {
  // a path target is untouched, and no command leaves the target empty
  expect(blockLine(0, 1, { tool: 'Edit', target: 'C:/a/b.ts', agent: 'coder', command: 'x' }).target).toBe('C:/a/b.ts')
  expect(blockLine(0, 1, { tool: 'Bash', target: '', agent: 't' }).target).toBe('')
})

test('warmLine carries the time and the minutes left, nothing else', () => {
  const l = warmLine(5, 2, { minutesLeft: 119.6, ok: true })
  expect(l).toEqual({ t: 'warm', at: 5, n: 2, minutesLeft: 120, ok: true })
})

test('the manager may Edit and Write ~/.claude/orchestrator.md, routing/ and agents/, whatever the path form', () => {
  const ctx = { home: 'C:\\Users\\studi.REAL' }
  for (const p of [
    'C:\\Users\\studi.REAL\\.claude\\orchestrator.md',
    'c:\\users\\STUDI.real\\.claude\\orchestrator.md',
    'C:/Users/studi.REAL/.claude/routing/shopify.md',
    'C:\\Users\\studi.REAL\\.claude\\agents\\coder.md',
    '~/.claude/orchestrator.md',
  ]) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(managerVerdict(tool, { file_path: p }, ctx)).toBeNull()
  }
  // everything else under .claude, a dot-dot escape and a project file stay refused
  for (const p of ['C:\\Users\\studi.REAL\\.claude\\settings.json', 'C:\\Users\\studi.REAL\\.claude\\routing\\..\\settings.json', 'C:\\Users\\studi.REAL\\work\\src\\app.ts', 'D:\\other\\.claude\\orchestrator.md']) {
    expect(managerVerdict('Edit', { file_path: p }, ctx)).not.toBeNull()
  }
  // with no home known nothing under .claude is allowed
  expect(managerVerdict('Edit', { file_path: 'C:\\Users\\studi.REAL\\.claude\\orchestrator.md' }, { home: undefined })).not.toBeNull()
})

test('guard writes: no escape through "..", "~", case, or a project file name found outside the project', () => {
  const ctx = { home: 'C:/Users/me', cwd: 'C:/work/site' }
  const write = (p: string) => managerVerdict('Write', { file_path: p }, ctx)
  const edit = (p: string) => managerVerdict('Edit', { file_path: p }, ctx)
  // the escapes from the review: all refused, for every write tool (the list names every path that got through)
  const escaped: string[] = []
  for (const p of [
    'C:/Users/me/.claude/plans/../settings.json',
    'C:/x/plans/../../Users/me/.claude/settings.json',
    'C:/Users/me/.claude/settings.json/../handoff.md',
    'C:/Users/me/.claude/routing/../settings.json',
    'C:\\Users\\me\\.claude\\agents\\..\\settings.json',
    '~/.claude/plans/../settings.json',
    '~/.claude/settings.json',
    '~/.claude/CLAUDE.md',
    '~/.claude/plans/x.md',
    'C:/Users/me/.claude/settings.json',
    'C:/elsewhere/map.md',
    'C:/elsewhere/HANDOFF.md',
    'C:/elsewhere/CLAUDE.md',
    'C:/elsewhere/plans/x.md',
    'C:/elsewhere/old-handoff/x.md',
    'C:/work/site-other/MAP.md',
    'C:/work/MAP.md',
    'C:/work/site/../MAP.md',
    'C:/work/site/plans/../../other/plans/x.md',
    'C:/work/site/src/app.ts',
    'C:/work/site/plans',
    'D:/work/site/MAP.md',
    'MAP.md/../../MAP.md',
    '../MAP.md',
    '',
  ]) {
    escaped.push(...[write, edit].filter(f => f(p) === null).map(() => p))
  }
  expect(escaped).toEqual([])
  // the legitimate paths, in any separator, case or relative form
  const refused: string[] = []
  for (const p of [
    'C:/work/site/MAP.md',
    'C:\\work\\site\\HANDOFF.md',
    'c:/WORK/Site/claude.md',
    'C:/work/site/plans/new.md',
    'C:/work/site/plans/sub/../new.md',
    'C:/work/site/old-handoff/HANDOFF-1.md',
    'C:/work/site/./MAP.md',
    'MAP.md',
    'plans/a.md',
    './old-handoff/a.md',
    '~/.claude/orchestrator.md',
    '~/.claude/routing/shopify.md',
    'C:/Users/me/.claude/agents/coder.md',
    'C:/Users/me/.claude/routing/x/../seo.md',
  ]) {
    refused.push(...[write, edit].filter(f => f(p) !== null).map(() => p))
  }
  expect(refused).toEqual([])
  // no folder known: nothing of the project is allowed, and a relative path cannot be placed
  expect(managerVerdict('Write', { file_path: 'C:/work/site/MAP.md' }, { home: 'C:/Users/me' })).not.toBeNull()
  expect(managerVerdict('Write', { file_path: 'MAP.md' }, { home: 'C:/Users/me' })).not.toBeNull()
  // a session started in the home folder does not make ~/.claude a project
  expect(managerVerdict('Write', { file_path: 'C:/Users/me/.claude/CLAUDE.md' }, { home: 'C:/Users/me', cwd: 'C:/Users/me' })).not.toBeNull()
  expect(managerVerdict('Write', { file_path: 'C:/Users/me/MAP.md' }, { home: 'C:/Users/me', cwd: 'C:/Users/me' })).toBeNull()
  // a drive root is no project
  expect(managerVerdict('Write', { file_path: 'C:/MAP.md' }, { home: 'C:/Users/me', cwd: 'C:/' })).not.toBeNull()
})

test('guard reads: the same normalisation, project files only inside the project, ~/.claude outside the three paths refused', () => {
  const ctx = { home: 'C:/Users/me', cwd: 'C:/work/site' }
  const read = (p: string) => managerVerdict('Read', { file_path: p }, ctx)
  expect([
    'C:/Users/me/.claude/plans/../settings.json',
    'C:/x/plans/../../Users/me/.claude/settings.json',
    'C:/Users/me/.claude/settings.json/../handoff.md',
    '~/.claude/settings.json',
    '~/.claude/projects/x/y.jsonl',
    'C:/elsewhere/map.md',
    'C:/elsewhere/claude.md',
    'C:/elsewhere/plans/x.md',
    'C:/work/site/src/../../other/MAP.md',
    'C:/work/site/src/app.ts',
  ].filter(p => read(p) === null)).toEqual([])
  expect(['C:/work/site/MAP.md', 'C:/work/site/docs/HANDOFF.md', 'C:/work/site/plans', 'C:/work/site/plans/a.md', 'CLAUDE.md', '~/.claude/orchestrator.md', 'C:/Users/me/.claude/routing', 'C:/Users/me/.claude/agents/x.md'].filter(p => read(p) !== null)).toEqual([])
  // Glob and Grep: scoped to the project, and a glob cannot name a file outside it
  const search = (tool: 'Glob' | 'Grep', input: Record<string, unknown>) => managerVerdict(tool, input, ctx)
  expect(search('Glob', { pattern: '**/MAP.md' })).toBeNull()
  expect(search('Glob', { pattern: 'plans/*.md', path: 'C:/work/site' })).toBeNull()
  expect(search('Grep', { pattern: 'x', glob: 'handoff.md' })).toBeNull()
  expect(search('Grep', { pattern: 'x', path: 'C:/work/site/plans' })).toBeNull()
  expect(search('Glob', { pattern: '**/MAP.md', path: 'C:/elsewhere' })).not.toBeNull()
  expect(search('Glob', { pattern: 'C:/elsewhere/MAP.md' })).not.toBeNull()
  expect(search('Glob', { pattern: '../other/MAP.md' })).not.toBeNull()
  expect(search('Glob', { pattern: 'plans/../../x/MAP.md' })).not.toBeNull()
  expect(search('Glob', { pattern: '**/MAP.md', path: 'C:/Users/me/.claude' })).not.toBeNull()
  expect(search('Grep', { pattern: 'x', glob: 'claude.md', path: 'C:/Users/me/.claude/plans/../' })).not.toBeNull()
  expect(search('Grep', { pattern: 'x', path: 'C:/Users/me/.claude' })).not.toBeNull()
  expect(search('Grep', { pattern: 'x' })).not.toBeNull()
  expect(search('Glob', { pattern: '**/*.ts' })).not.toBeNull()
})

// ── Through the hooks ───────────────────────────────────────────────────────────────────────────────────────

test('a verifier cut at its turn cap with no verdict line is "cut"; one with a PASS line keeps it', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'verify the footer' })
  const ids: string[] = []
  for (const answer of ['I ran out of turns before a verdict', 'PASS footer link ok']) {
    const spawned = await $.agent.spawn({ ...SPAWN, tool_use_id: `u${ids.length}`, prompt: 'Verify the footer' })
    const id = String(spawned.agentId)
    ids.push(id)
    for (const index of [0, 1]) for await (const _ of $.turn.step({ turnId: 't1', index, agentId: id, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
    await $.turn.complete({ turnId: 't1', agentId: id, reason: 'answer', isAborted: false, durationMs: 1000, answer, usage })
  }
  const verdicts = linesOf(written).filter(l => l.t === 'verdict')
  expect(verdicts.map(l => l.verdict)).toEqual(['cut', 'pass'])
  expect(linesOf(written).filter(l => l.t === 'end').map(l => l.end)).toEqual(['maxTurns', 'maxTurns'])
})

test('junk records: no empty task, no zero main line', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: '   ' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 10, answer: '' })
  await $.turn.start({ turnId: 't2', text: 'real work' })
  await $.turn.complete({ turnId: 't2', reason: 'answer', isAborted: false, durationMs: 10, answer: '', usage })
  const lines = linesOf(written)
  expect(lines.filter(l => l.t === 'task').map(l => l.text)).toEqual(['real work'])
  expect(lines.filter(l => l.t === 'main')).toHaveLength(1)
  expect(lines.filter(l => l.t === 'main')[0]).toMatchObject({ n: 1, in: 10, out: 5 })
})

test('one file per session: a log of the same session id is continued', async ($, on) => {
  const { written } = world(on)
  const earlier = `${HOME}/.claude/cr-logs/site/2026-11-17-1000-sess-1.jsonl`
  written[earlier] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off' }, { t: 'task', at: 2, n: 1, text: 'first', mode: 'off' }])
  // a different session's file must not be taken
  written[`${HOME}/.claude/cr-logs/site/2026-11-17-1100-other-sess-1.jsonl`] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off' }])
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'second' })
  expect(jsonls(written)).toHaveLength(2)
  expect(linesOf(written, earlier).filter(l => l.t === 'task').map(l => [l.n, l.text])).toEqual([[1, 'first'], [2, 'second']])
})

test('a spare-* session moves under the real project name, and its report is written before the session ends', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/Temp/spare-ab12', surface: 'desktop', isInteractive: true })
  expect(jsonls(written)[0]).toContain('/cr-logs/spare-ab12/')
  await $.turn.start({ turnId: 't1', text: 'work', cwd: 'C:/work/site' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 10, answer: '', usage })
  const real = jsonls(written).find(p => p.includes('/cr-logs/site/'))
  expect(real).toBeDefined()
  expect(linesOf(written, real)[0]).toMatchObject({ t: 'session', project: 'site' })
  expect(linesOf(written, real).some(l => l.t === 'task')).toBe(true)
  // the old file is emptied, not duplicated
  expect(linesOf(written, jsonls(written).find(p => p.includes('/spare-ab12/'))).length).toBe(0)
  // no session.end yet: the .md is already there
  expect(Object.keys(written).some(p => p.includes('/cr-logs/site/') && p.endsWith('.md'))).toBe(true)
})

test('a spare session with no cwd on its turns keeps its name and still gets an .md at the end', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/Temp/spare-ab12', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'work' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(Object.keys(written).some(p => p.includes('/spare-ab12/') && p.endsWith('.md'))).toBe(true)
})

test('each keep-warm ping is logged with the time and minutes left, never its text', { timeoutMs: 120_000 }, async ($, on) => {
  const { written, clock } = world(on)
  on('model.fork', () => ({ value: { isAnswered: true as const, text: 'WARMTEXT', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } as never }))
  await $.session.start({ cwd: 'C:/work/site', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'cr-warm', args: '3h', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 300, answer: '', usage })
  for (let left = WARM_EVERY_MS / 60_000 + 1; left > 0; left -= 10) await clock.advance(Math.min(left, 10) * 60_000)
  const warm = linesOf(written).filter(l => l.t === 'warm')
  expect(warm).toHaveLength(1)
  expect(Object.keys(warm[0] ?? {}).sort()).toEqual(['at', 'cached', 'in', 'minutesLeft', 'model', 'n', 'ok', 'out', 't', 'written'])
  expect(Number(warm[0]?.minutesLeft)).toBeGreaterThan(100)
  expect(Number(warm[0]?.minutesLeft)).toBeLessThanOrEqual(130)
  expect(JSON.stringify(written).includes('WARMTEXT')).toBe(false)
})

test('wf rides only on workflow-subagent spawns, not on later plain Agent spawns', async ($, on) => {
  const { written } = world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  await $.tool.call({ tool: 'Workflow', meta: { name: 'audit' }, agentId: undefined } as never)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'w1', subagentType: 'workflow-subagent', parentModel: '' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'p1', subagentType: 'coder' })
  const agents = linesOf(written).filter(l => l.t === 'agent')
  expect(agents[0]).toMatchObject({ wf: 'audit' })
  expect(agents[1]).not.toHaveProperty('wf')
})

test('the route strip shows the over-ultraMax warning, and a general-purpose launch warns while orchestrating', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-band', args: 'route', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  for (let i = 0; i < 6; i++) await $.agent.spawn({ ...SPAWN, tool_use_id: `w${i}`, subagentType: 'workflow-subagent', parentModel: '' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'g1', subagentType: 'general-purpose' })
  const strip = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await strip.find({ text: /ultracode: 6 workflow agents/ })).toBeDefined()
  expect(await strip.find({ text: /general-purpose launched: use a roster agent/ })).toBeDefined()
  expect(await strip.find({ text: /Weekly/ })).toBeUndefined()
  await strip.unmount()
  // a new task clears the general-purpose warning
  await $.turn.start({ turnId: 't2', text: 'next task' })
  const again = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await again.find({ text: /general-purpose launched/ })).toBeUndefined()
  await again.unmount()
})

test('no general-purpose warning when the orchestrator is off', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /general-purpose launched/ })).toBeUndefined()
  await band.unmount()
})

test('a fresh state has the orchestrator on, with the rules injected at session.start', async ($, on) => {
  const { session } = world(on)
  expect(DEFAULT_OPTIONS.orchestrator).toBe('on')
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  const rows = session.appended()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows[0]?.message)).toMatch(/orchestrator-rules.*You manage/)
  const said = (await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? ''
  expect(said).toMatch(/orchestrator: on/)
})

test('with the rules file missing the default falls back to off, with a notice, and nothing fails', async ($, on) => {
  const { session, toasts } = world(on, {})
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  expect(session.appended()).toHaveLength(0)
  expect(toasts.some(t => /orchestrator off/.test(t))).toBe(true)
  const said = (await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? ''
  expect(said).toMatch(/orchestrator: off/)
})

test('/cr-orchestrator off still works after the default-on start', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })
  const said = (await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? ''
  expect(said).toMatch(/orchestrator: off/)
  expect((await $.tool.call({ tool: 'Edit', file_path: 'C:/work/site/a.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
})

// ── Review fixes: log files, rules on resume, workflow counter ──────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 18, 9, 30)

test('a spare session moving into a project that already has a log of the same session loses no record', async ($, on) => {
  const { written } = world(on)
  const earlier = `${HOME}/.claude/cr-logs/site/${stamp(NOW)}-sess-1.jsonl`
  written[earlier] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off' }, { t: 'task', at: 2, n: 1, text: 'first', mode: 'off' }])
  await $.session.start({ cwd: 'C:/Temp/spare-ab12', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'second', cwd: 'C:/work/site' } as never)
  const lines = linesOf(written, earlier)
  expect(lines.filter(l => l.t === 'task').map(l => [l.n, l.text])).toEqual([[1, 'first'], [2, 'second']])
  expect(lines.filter(l => l.t === 'session' && l.phase === 'start')).toHaveLength(2)
  // the spare file is emptied, not the target; a later turn continues the numbering
  expect(linesOf(written, jsonls(written).find(p => p.includes('/spare-ab12/'))).length).toBe(0)
  await $.turn.start({ turnId: 't2', text: 'third' })
  expect(linesOf(written, earlier).filter(l => l.t === 'task').map(l => l.n)).toEqual([1, 2, 3])
})

test('a spare session moving where a file of its own name exists but cannot be read keeps both files', async ($, on) => {
  const { written } = world(on)
  const taken = `${HOME}/.claude/cr-logs/site/${stamp(NOW)}-sess-1.jsonl`
  written[taken] = `${JSON.stringify({ t: 'task', at: 2, n: 1, text: 'first', mode: 'off' })}\n{half a line`
  const before = written[taken]
  await $.session.start({ cwd: 'C:/Temp/spare-ab12', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'second', cwd: 'C:/work/site' } as never)
  expect(written[taken]).toBe(before)
  const spare = jsonls(written).find(p => p.includes('/spare-ab12/'))
  expect(linesOf(written, spare).some(l => l.t === 'task' && l.text === 'second')).toBe(true)
})

test('with no readable session id the log is a new stamped file, never an earlier one', async ($, on) => {
  const { written } = world(on, FILES, null)
  const earlier = `${HOME}/.claude/cr-logs/site/2026-11-17-1000-session.jsonl`
  const sameMinute = `${HOME}/.claude/cr-logs/site/${stamp(NOW)}-session.jsonl`
  const before = toJsonl([{ t: 'task', at: 2, n: 1, text: 'first', mode: 'off' }])
  written[earlier] = before
  written[sameMinute] = before
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'second' })
  expect(written[earlier]).toBe(before)
  expect(written[sameMinute]).toBe(before)
  const fresh = jsonls(written).filter(p => p !== earlier && p !== sameMinute)
  expect(fresh).toHaveLength(1)
  expect(linesOf(written, fresh[0]).filter(l => l.t === 'task').map(l => l.text)).toEqual(['second'])
})

test('a resumed conversation that already holds the rules does not get them again', async ($, on) => {
  const { session } = world(on)
  on('session.messages', () => ({ value: [{ role: 'user', text: '<orchestrator-rules source="~/.claude/orchestrator.md">\nYou manage.\n</orchestrator-rules>', toolUses: [] }] as never }))
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  expect(session.appended()).toHaveLength(0)
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? '').toMatch(/orchestrator: on .*rules loaded/)
})

test('a failed rules injection turns the orchestrator off with a toast, so the guard never blocks without rules', async ($, on) => {
  const { toasts } = world(on, FILES, 'sess-1', true)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  expect(toasts.join(" # ")).toMatch(/orchestrator off.*could not be loaded.*append refused/)
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? '').toMatch(/orchestrator: off/)
  await $.turn.start({ turnId: 't1', text: 'go' })
  expect((await $.tool.call({ tool: 'Edit', file_path: 'C:/work/site/a.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
})

test('the guard in the hook: project files only in the session folder, settings.json never', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'go' })
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
  expect((await edit('C:/work/site/MAP.md')).deny).toBeUndefined()
  expect((await edit(`${HOME}/.claude/plans/../settings.json`)).deny).toBeDefined()
  expect((await edit('C:/elsewhere/MAP.md')).deny).toBeDefined()
})

test('only workflow-subagent spawns count as workflow agents, not a plain Agent call after a Workflow', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:/work/site', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-band', args: 'route', ...CMD })
  await $.turn.start({ turnId: 't1', text: 'run the workflow' })
  await $.tool.call({ tool: 'Workflow', meta: { name: 'audit' }, agentId: undefined } as never)
  for (let i = 0; i < 6; i++) await $.agent.spawn({ ...SPAWN, tool_use_id: `w${i}`, subagentType: 'workflow-subagent', parentModel: '' })
  for (let i = 0; i < 3; i++) await $.agent.spawn({ ...SPAWN, tool_use_id: `p${i}`, subagentType: 'coder' })
  const strip = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await strip.find({ text: /ultracode: 6 workflow agents/ })).toBeDefined()
  expect(await strip.find({ text: /ultracode: 9 workflow agents/ })).toBeUndefined()
  await strip.unmount()
})

// ── Verifier gaps: glob refusals, .claude / 8.3 names in the project clause, subcommand allowlist ───────────────

test('Glob and Grep refuse patterns that can spell a climb; plain patterns stay allowed', () => {
  const ctx = { home: 'C:/Users/me', cwd: 'C:/work/site' }
  for (const pattern of ['plans/{..,x}/*.md', '{../x,}/MAP.md', 'plans/[.][.]/[.][.]/x.md', 'plans/.. /x', 'plans/%2e%2e/MAP.md', '~/MAP.md', 'plans/{a,b}/x.md']) {
    expect(managerVerdict('Glob', { pattern }, ctx)).not.toBeNull()
    expect(managerVerdict('Grep', { pattern: 'x', glob: pattern }, ctx)).not.toBeNull()
  }
  expect(managerVerdict('Glob', { pattern: 'plans/*.md' }, ctx)).toBeNull()
  expect(managerVerdict('Glob', { pattern: '**/MAP.md' }, ctx)).toBeNull()
  // "**/*.ts" names no allowed file and is not under plans/, so it stays refused by the existing rule
  expect(managerVerdict('Glob', { pattern: '**/*.ts', path: 'C:/work/site/plans' }, ctx)).toBeNull()
})

test('project clause: no .claude segment and no 8.3 "~" segment, ~/.claude only through its own clause', () => {
  const ctx = { home: 'C:/Users/studi.REAL', cwd: 'C:\\Users\\STUDI~1.REA' }
  for (const p of [
    'C:\\Users\\STUDI~1.REA\\.claude\\CLAUDE.md',
    'C:\\Users\\STUDI~1.REA\\.claude\\agents\\HANDOFF.md',
    'C:\\Users\\STUDI~1.REA\\.claude\\plans\\x.md',
    'C:\\Users\\STUDI~1.REA\\CLAUDE~1\\MAP.md',
    '.claude/MAP.md',
    'plans/PROGRA~1/x.md',
  ]) {
    for (const tool of ['Read', 'Write', 'Edit']) expect(managerVerdict(tool, { file_path: p }, ctx), `${tool} ${p}`).not.toBeNull()
  }
  expect(managerVerdict('Grep', { pattern: 'x', path: 'C:\\Users\\STUDI~1.REA\\.claude' }, ctx)).not.toBeNull()
  // the project itself, even under a short-name cwd, still works
  expect(managerVerdict('Write', { file_path: 'C:\\Users\\STUDI~1.REA\\MAP.md' }, ctx)).toBeNull()
  expect(managerVerdict('Read', { file_path: 'plans/a.md' }, ctx)).toBeNull()
  // the long-form ~/.claude clause is unchanged
  expect(managerVerdict('Edit', { file_path: 'C:/Users/studi.REAL/.claude/agents/coder.md' }, ctx)).toBeNull()
})

test('commandWords: per-program subcommand allowlist, token-like first words give nothing', () => {
  for (const [command, kept] of [
    ['git sk-abc', 'git'],
    ['git sk-abc123', 'git'],
    ['git ghp_abcdefghijklmnop', 'git'],
    ['git eyJhbGciOi', 'git'],
    ['git status', 'git status'],
    ['git cherry-pick abc', 'git cherry-pick'],
    ['git frobnicate', 'git'],
    ['gh pr create', 'gh pr'],
    ['gh secret-name', 'gh'],
    ['npm run build', 'npm run'],
    ['npm hunter2', 'npm'],
    ['npx create-app', 'npx'],
    ['constructor status', 'constructor'],
    ['sk-abcdef1234567890 status', ''],
    ['ghp_abcdefghijklmnop1234 push', ''],
    ['eyJhbGciOiJIUzI1NiJ9 x', ''],
    ['aaaaaaaaaaaaaaaaaaaaaa x', ''],
    ['abc123def456ghi789 x', ''],
  ] as const) expect(commandWords(command), command).toBe(kept)
})
