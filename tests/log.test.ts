import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import { clip, endLine, envLogPaths, fromJsonl, isAbsoluteDir, isTempCwd, launchLine, legacyLogPaths, mdAll, mdOf, projectLogPaths, projectName, reviewPrompt, sessionIds, skillsNamed, taskLine, toJsonl, totalsOf, verdictOf, mainLine } from '../hooks/sessionlog'

// The session log: written by the hooks, one JSON line per event, nothing from a payload, a prompt body or an environment value.

const PLUGIN = 'agent-ClaudeRouter'
const HOME = 'C:/Users/me'
const CWD = 'C:/work/site'
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const FILES: Record<string, string> = {
  [`${HOME}/.claude/agents/coder.md`]: '---\nname: coder\nmodel: sonnet\neffort: medium\nmaxTurns: 3\n---\nbody',
  [`${HOME}/.claude/agents/verifier.md`]: '---\nname: verifier\nmodel: sonnet\neffort: high\n---\nbody',
  [`${HOME}/.claude/orchestrator.md`]: '# Orchestrator rules\nYou manage.\n',
  [`${HOME}/.claude/clauderouter-prices.json`]: '{"models":{"sonnet":{"input":3,"output":15,"cacheWrite":4,"cacheRead":0.5},"fable":{"input":10,"output":50,"cacheWrite":12,"cacheRead":1}}}',
}
const SECRET_ENV = 'sk-live-ENVSECRET'
const SPAWN = { tool_use_id: 'u1', prompt: 'x', description: 'x', subagentType: 'coder', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-fable-5-2', background: true, fork: false }
const usage = (i: number, o: number, w: number, r: number, model: string) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: w, cache_read_input_tokens: r, model })

// extraEnv: more environment variables (CR_LOG_DIR); failWrite: paths whose write fails (an unwritable folder);
// failRead: paths that exist but whose read fails; sid: the session id
function world(on: On, extraEnv: Record<string, string> = {}, failWrite: (path: string) => boolean = () => false, failRead: (path: string) => boolean = () => false, sid = 'sess-1') {
  const written: Record<string, string> = {}
  const spawned: { id: string }[] = []
  mock.clock(on, { now: Date.UTC(2026, 10, 18, 9, 30) })
  mock.env(on, { USERPROFILE: HOME, SOME_API_KEY: SECRET_ENV, CLAUDE_CODE_EFFORT_LEVEL: 'auto', ...extraEnv })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sid }))
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId?: string }).sessionId ?? 'sess-1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const path = e.path.split('\\').join('/')
    if (failRead(path)) throw new Error('EACCES')
    const text = written[path] ?? FILES[path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    const path = e.path.split('\\').join('/')
    if (failWrite(path)) throw new Error('EACCES')
    written[path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => {
    const path = e.path.split('\\').join('/')
    return { value: (written[path] ?? FILES[path]) !== undefined }
  })
  on('fs.list', (_$, e) => {
    const dir = e.path.split('\\').join('/').replace(/\/+$/, '')
    return { value: Object.keys(written).filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('agent.spawn', (_$, e) => {
    const id = `a${spawned.length + 1}`
    spawned.push({ id })
    return { model: e.model ?? 'claude-sonnet-5-5', agentId: id }
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return written
}

const jsonlOf = (written: Record<string, string>) => {
  const path = Object.keys(written).find(p => p.endsWith('.jsonl'))
  return { path, text: path ? (written[path] ?? '') : '' }
}

// A whole session, driven the way the engine drives it
async function simulate($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  await $.turn.start({ turnId: 't1', text: `Fix the footer and add a test. ${'x'.repeat(200)} TAILSECRET` })
  // the guard refuses the manager's own Bash and Edit
  await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: BASHSECRET" https://x' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/work/site/src/footer.ts', old_string: 'OLDSECRET', new_string: 'NEWSECRET' })
  // a coder with a brief that names a skill; a second line holds a secret that must not be logged
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u1', prompt: 'Change the footer link in src/footer.ts\nSkills: impeccable, seo\npassword: hunter2' })
  await $.tool.call({ tool: 'Skill', skill: 'impeccable', agentId: 'a1' })
  await $.tool.call({ tool: 'Skill', skill: 'frontend-design', agentId: 'a1' })
  await $.tool.call({ tool: 'mcp__vercel__get_deployment', agentId: 'a1', payload: 'MCPSECRET' })
  for (const index of [0, 1, 2]) for await (const _ of $.turn.step({ turnId: 't1', index, agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', isAborted: false, durationMs: 8000, answer: 'done', usage: usage(1000, 500, 2000, 10_000, 'claude-sonnet-5-5') })
  // the orchestrator sends the coder back, then a verifier judges
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'FOLLOWSECRET redo it' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'u2', subagentType: 'verifier', prompt: 'Verify src/footer.ts' })
  await $.turn.complete({ turnId: 't1', agentId: 'a2', reason: 'answer', isAborted: false, durationMs: 4000, answer: 'PASS npm test 12/12\nFAIL browser check: link 404\nNOT CHECKED mobile', usage: usage(300, 100, 0, 5000, 'claude-sonnet-5-5') })
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 20_000, answer: '', usage: usage(500, 200, 1000, 40_000, 'claude-fable-5-2') })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
}

test('a simulated session writes the expected lines, in order, from named fields only', async ($, on) => {
  const written = world(on)
  await simulate($)
  const { path, text } = jsonlOf(written)
  expect(path).toBe('C:/work/site/.claude/cr-log.jsonl')
  const lines = fromJsonl(text)
  const kinds = lines.map(l => l.t)
  expect(kinds).toEqual(['session', 'task', 'block', 'block', 'agent', 'skill', 'skill', 'mcp', 'end', 'followup', 'agent', 'end', 'verdict', 'main', 'session'])
  expect(lines[0]).toMatchObject({ phase: 'start', project: 'site', mode: 'on' })
  expect(lines[1]).toMatchObject({ n: 1, mode: 'on' })
  expect(String(lines[1]?.text)).toHaveLength(120)
  expect(lines[2]).toMatchObject({ tool: 'Bash', target: 'curl', agent: 'test-runner' })
  expect(lines[3]).toMatchObject({ tool: 'Edit', target: 'C:/work/site/src/footer.ts', agent: 'coder' })
  expect(lines[4]).toMatchObject({ agent: 'coder', by: { model: 'frontmatter', effort: 'frontmatter' }, brief: 'Change the footer link in src/footer.ts', skills: ['impeccable', 'seo'] })
  // a skill the brief named, and one the agent chose
  expect(lines[5]).toMatchObject({ skill: 'impeccable', agent: 'coder', named: true })
  expect(lines[6]).toMatchObject({ skill: 'frontend-design', agent: 'coder', named: false })
  expect(lines[7]).toMatchObject({ agent: 'coder', server: 'vercel', tool: 'get_deployment' })
  // 3 requests against maxTurns 3: it hit the cap
  expect(lines[8]).toMatchObject({ t: 'end', agent: 'coder', in: 3000, cached: 10_000, out: 500, sec: 8, turns: 3, end: 'maxTurns' })
  // the same $3/$15/$4/$0.5 prices as the file: 1000 in + 2000 writes + 10k cached + 500 out
  expect(Math.round(Number(lines[8]?.cost) * 1e6) / 1e6).toBe(0.0235)
  expect(lines[9]).toMatchObject({ t: 'followup', agent: 'coder' })
  expect(lines[12]).toMatchObject({ t: 'verdict', verdict: 'fail', pass: 1, fail: 1, unchecked: 1 })
  expect(lines[13]).toMatchObject({ t: 'main', model: 'claude-fable-5-2', in: 1500, cached: 40_000, out: 200 })
  expect(lines[14]).toMatchObject({ phase: 'end' })
  // every row carries the session id and a time
  expect(lines.every(l => l.sid === 'sess-1' && typeof l.at === 'number')).toBe(true)
})

test('nothing from a tool payload, a prompt body or an environment value reaches the log', async ($, on) => {
  const written = world(on)
  await simulate($)
  const everything = Object.values(written).join('\n')
  for (const secret of ['BASHSECRET', 'OLDSECRET', 'NEWSECRET', 'hunter2', 'MCPSECRET', 'FOLLOWSECRET', 'TAILSECRET', SECRET_ENV, 'Authorization']) {
    expect(everything.includes(secret)).toBe(false)
  }
})

test('the .md totals equal the sum of the lines', async ($, on) => {
  const written = world(on)
  await simulate($)
  const { text } = jsonlOf(written)
  const lines = fromJsonl(text)
  const mdPath = Object.keys(written).find(p => p.endsWith('.md'))
  expect(mdPath).toBeDefined()
  const md = written[mdPath ?? ''] ?? ''
  const rows = lines.filter(l => l.t === 'main' || l.t === 'end')
  const sum = (k: string) => rows.reduce((a, l) => a + Number(l[k] ?? 0), 0)
  // the per-model totals rows add up to the lines' sums
  const modelRows = md.split('\n').filter(l => /^\| claude-/.test(l)).map(l => l.split('|').map(c => c.trim()))
  expect(modelRows.reduce((a, r) => a + Number(r[2]), 0)).toBe(sum('in'))
  expect(modelRows.reduce((a, r) => a + Number(r[3]), 0)).toBe(sum('cached'))
  expect(modelRows.reduce((a, r) => a + Number(r[4]), 0)).toBe(sum('out'))
  // main-thread share, and the cost, are the lines' too
  const mainShare = Math.round(((1500 + 200) / (sum('in') + sum('out'))) * 100)
  expect(md).toContain(`Main-thread share: ${mainShare}%`)
  const cost = rows.reduce((a, l) => a + Number(l.cost ?? 0), 0)
  expect(md).toContain(`- Cost: $${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`)
  expect(md).toContain('Guard blocks: 2 · follow-ups: 1')
  // one table per task: the orchestrator row, the coder (maxTurns, follow-up) and the verifier (fail)
  expect(md).toMatch(/\| orchestrator \| main \| claude-fable-5-2 .*\| 2 guard blocks \|/)
  expect(md).toMatch(/\| Change the footer link in src\/footer\.ts \| coder \| claude-sonnet-5-5 \| medium \| impeccable, frontend-design \| 3000 \/ 10000 \/ 500 \| \$[\d.]+ \| 0:08 \| maxTurns · 1 follow-up \|/)
  expect(md).toMatch(/\| Verify src\/footer\.ts \| verifier .*\| ended · fail \|/)
})

test('/cr-log shows this session as a table, /cr-log last the previous session of the same log', async ($, on) => {
  const written = world(on)
  // an earlier session of the same project, already in the project's common log
  written[`${CWD}/.claude/cr-log.jsonl`] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off', sid: 'old' }, { ...taskLine(2, 1, 'old task', 'off'), sid: 'old' }])
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'new task' })
  const now = (await $.command.run({ command: 'cr-log', args: '', ...CMD })).text ?? ''
  expect(now).toMatch(/## Task 1 · new task/)
  expect(now).not.toMatch(/old task/)
  const last = (await $.command.run({ command: 'cr-log', args: 'last', ...CMD })).text ?? ''
  expect(last).toMatch(/## Task 1 · old task/)
  expect(last).not.toMatch(/new task/)
  expect(last).toContain(`${CWD}/.claude/cr-log.jsonl`)
  // the old session's rows are untouched by the new session's appends
  expect(fromJsonl(written[`${CWD}/.claude/cr-log.jsonl`] ?? '').filter(l => l.sid === 'old')).toHaveLength(2)
})

test('/cr-log last reads the per-session files of earlier versions only when the new log has no rows', async ($, on) => {
  const written = world(on)
  const earlier = `${HOME}/.claude/cr-logs/site/2026-11-17-1000-old.jsonl`
  const body = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off' }, taskLine(2, 1, 'old task', 'off')])
  written[earlier] = body
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'new task' })
  const last = (await $.command.run({ command: 'cr-log', args: 'last', ...CMD })).text ?? ''
  expect(last).toMatch(/## Task 1 · old task/)
  expect(last).toContain('2026-11-17-1000-old.jsonl')
  // nothing under the old folder was moved or rewritten
  expect(written[earlier]).toBe(body)
})

test('the log lives in <project>/.claude, with a .gitignore of its own and the project .gitignore untouched', async ($, on) => {
  const written = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(Object.keys(written).filter(p => p.includes('cr-log') || p.endsWith('.gitignore')).sort()).toEqual([`${CWD}/.claude/.gitignore`, `${CWD}/.claude/cr-log.jsonl`, `${CWD}/.claude/cr-log.md`])
  expect(written[`${CWD}/.claude/.gitignore`]).toMatch(/^cr-log\.\*$/m)
  expect(written[`${CWD}/.gitignore`]).toBeUndefined()
})

test('no .gitignore is written when the project already ignores the log', async ($, on) => {
  const written = world(on)
  written[`${CWD}/.gitignore`] = 'node_modules\n.claude/\n'
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(written[`${CWD}/.claude/.gitignore`]).toBeUndefined()
  expect(written[`${CWD}/.gitignore`]).toBe('node_modules\n.claude/\n')
  expect(written[`${CWD}/.claude/cr-log.jsonl`]).toBeDefined()
})

const IGNORE = `${CWD}/.claude/.gitignore`
const starts = async ($: Engine) => { await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true }) }

test('the .claude/.gitignore is written once and a second start leaves it as it is', async ($, on) => {
  const written = world(on)
  await starts($)
  expect(written[IGNORE]).toBe('cr-log.*\ncr-reviews/\n')
  await starts($)
  expect(written[IGNORE]).toBe('cr-log.*\ncr-reviews/\n')
})

test('an existing readable .claude/.gitignore gets the missing rules appended, its own lines kept', async ($, on) => {
  const written = world(on)
  written[IGNORE] = 'keep-me\n*.tmp'
  await starts($)
  expect(written[IGNORE]).toBe('keep-me\n*.tmp\ncr-log.*\ncr-reviews/\n')
})

test('an existing .claude/.gitignore that cannot be read is left untouched', async ($, on) => {
  const written = world(on, {}, () => false, p => p === IGNORE)
  written[IGNORE] = 'secret-rules\n'
  await starts($)
  expect(written[IGNORE]).toBe('secret-rules\n')
  expect(written[`${CWD}/.claude/cr-log.jsonl`]).toBeDefined()
})

test('a root .gitignore with only cr-log.md does not count as covered', async ($, on) => {
  const written = world(on)
  written[`${CWD}/.gitignore`] = 'cr-log.md\n'
  await starts($)
  expect(written[IGNORE]).toBe('cr-log.*\ncr-reviews/\n')
  expect(written[`${CWD}/.gitignore`]).toBe('cr-log.md\n')
})

test('a root .gitignore with both exact log names and cr-reviews/ counts as covered, nothing is written',async ($, on) => {
  const a = world(on)
  a[`${CWD}/.gitignore`] = 'cr-log.md\ncr-log.jsonl\ncr-reviews/\n'
  await starts($)
  expect(a[IGNORE]).toBeUndefined()
})

test('a root .gitignore with only cr-log.* still gets cr-reviews/ written', async ($, on) => {
  const written = world(on)
  written[`${CWD}/.gitignore`] = 'cr-log.*\n'
  await starts($)
  expect(written[IGNORE]).toBe('cr-reviews/\n')
})

test('CR_LOG_DIR that cannot be written falls back to ~/.claude/cr-logs/<project>/cr-log.jsonl', async ($, on) => {
  const written = world(on, { CR_LOG_DIR: 'D:/logs/cr' }, p => p.startsWith('D:/logs/cr/'))
  await starts($)
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(fromJsonl(written[`${HOME}/.claude/cr-logs/site/cr-log.jsonl`] ?? '').map(l => l.t)).toEqual(['session', 'task', 'session'])
  expect(Object.keys(written).some(p => p.startsWith('D:/logs/cr/'))).toBe(false)
})

test('a session id with $& or $1 is stored intact, in the lines and in the .md heading', async ($, on) => {
  const sid = 'a$&b$1c'
  const written = world(on, {}, () => false, () => false, sid)
  await starts($)
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.session.end({ reason: 'other', sessionId: sid } as never)
  expect(fromJsonl(written[`${CWD}/.claude/cr-log.jsonl`] ?? '').every(l => l.sid === sid)).toBe(true)
  expect(written[`${CWD}/.claude/cr-log.md`]).toContain(` · ${sid}`)
})

test('CR_LOG_DIR wins over everything: the log and its .md go there, nothing in the project', async ($, on) => {
  const written = world(on, { CR_LOG_DIR: 'D:/logs/cr' })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(Object.keys(written).filter(p => p.endsWith('.jsonl') || p.endsWith('.md'))).toEqual(['D:/logs/cr/cr-log.jsonl', 'D:/logs/cr/cr-log.md'])
  expect(Object.keys(written).some(p => p.startsWith(CWD))).toBe(false)
})

test('a project folder that cannot be written falls back to ~/.claude/cr-logs/<project>/cr-log.jsonl', async ($, on) => {
  const written = world(on, {}, p => p.startsWith(`${CWD}/`))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(fromJsonl(written[`${HOME}/.claude/cr-logs/site/cr-log.jsonl`] ?? '').map(l => l.t)).toEqual(['session', 'task', 'session'])
  expect(written[`${HOME}/.claude/cr-logs/site/cr-log.md`]).toBeDefined()
})

test('a temp or spare folder logs to the home fallback, and its rows are appended to the real project log on a later turn', async ($, on) => {
  const written = world(on)
  const real = `${CWD}/.claude/cr-log.jsonl`
  written[real] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off', sid: 'other' }])
  await $.session.start({ cwd: 'C:/Temp/spare-ab12', surface: 'desktop', isInteractive: true })
  const spare = `${HOME}/.claude/cr-logs/spare-ab12/cr-log.jsonl`
  expect(fromJsonl(written[spare] ?? '').map(l => l.t)).toEqual(['session'])
  await $.turn.start({ turnId: 't1', text: 'work', cwd: CWD } as never)
  const rows = fromJsonl(written[real] ?? '')
  expect(rows.map(l => [l.sid, l.t])).toEqual([['other', 'session'], ['sess-1', 'session'], ['sess-1', 'task']])
  expect(rows[1]).toMatchObject({ project: 'site' })
  expect(fromJsonl(written[spare] ?? '')).toHaveLength(0)
  expect(written[`${CWD}/.claude/.gitignore`]).toMatch(/cr-log\.\*/)
})

test('two sessions in one project append to the same log and keep each other rows', async ($, on) => {
  const written = world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  // another session writes into the file while this one runs
  written[`${CWD}/.claude/cr-log.jsonl`] += toJsonl([{ t: 'task', at: 5, n: 1, text: 'theirs', mode: 'off', sid: 'sess-2' }])
  await $.turn.start({ turnId: 't1', text: 'mine' })
  const rows = fromJsonl(written[`${CWD}/.claude/cr-log.jsonl`] ?? '')
  expect(rows.map(l => [l.sid, l.t])).toEqual([['sess-1', 'session'], ['sess-2', 'task'], ['sess-1', 'task']])
})

test('/cr-review registers one Sonnet agent at medium effort with Read and Grep only, and names the logs it will read', async ($, on) => {
  const written = world(on)
  const registered: Record<string, unknown>[] = []
  on('agent.register', (_$, e) => {
    registered.push(e as unknown as Record<string, unknown>)
    return { value: { agent: `${PLUGIN}:log-review` } }
  })
  for (const n of [1, 2, 3]) written[`${HOME}/.claude/cr-logs/site/2026-11-1${n}-1000-s${n}.jsonl`] = toJsonl([{ t: 'session', at: n, phase: 'start', project: 'site', mode: 'off' }])
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(registered[0]).toMatchObject({ name: 'log-review', model: 'sonnet', effort: 'medium', tools: ['Read', 'Grep'], omitClaudeMd: true })
  const prompt = reviewPrompt(['/a/1.jsonl', '/a/2.jsonl'], 'site')
  expect(reviewPrompt(['/a/cr-log.jsonl'], 'site', ['s1', 's2'])).toContain('sid is one of these 2: s1, s2')
  expect(prompt).toContain('Read only these 2 files')
  expect(prompt).toContain('/a/2.jsonl')
  expect(prompt).toMatch(/at most five proposed changes/i)
  expect(prompt).toMatch(/You change nothing and write no file/)
})

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────────────────

test('names, paths and cuts', () => {
  expect(projectName('C:\\Users\\me\\Documents\\ClaudeCodeProjects\\locationsite')).toBe('locationsite')
  expect(projectLogPaths('C:\\work\\site')).toEqual({ dir: 'C:/work/site/.claude', jsonl: 'C:/work/site/.claude/cr-log.jsonl', md: 'C:/work/site/.claude/cr-log.md', reviews: 'C:/work/site/.claude/cr-reviews' })
  expect(legacyLogPaths('C:\\Users\\me', '/p/site').jsonl).toBe('C:/Users/me/.claude/cr-logs/site/cr-log.jsonl')
  expect(envLogPaths('D:\\logs\\').jsonl).toBe('D:/logs/cr-log.jsonl')
  expect(isAbsoluteDir('D:/logs')).toBe(true)
  expect(isAbsoluteDir('logs/cr')).toBe(false)
  expect([isTempCwd('C:/Temp/x'), isTempCwd('/tmp/x'), isTempCwd('C:/work/spare-1'), isTempCwd('C:/work/site')]).toEqual([true, true, true, false])
  const rows = [{ t: 'session', at: 1, phase: 'start', project: 'p', mode: 'off', sid: 'a' }, { t: 'session', at: 2, phase: 'start', project: 'p', mode: 'off', sid: 'b' }, { t: 'task', at: 3, n: 1, text: 'x', mode: 'off', sid: 'a' }]
  expect(sessionIds(rows)).toEqual(['a', 'b'])
  expect(mdAll(rows).indexOf('· a')).toBeLessThan(mdAll(rows).indexOf('· b'))
  expect(clip('a\n  b   c', 60)).toBe('a b c')
  expect(skillsNamed('do it\nSkills: `impeccable`, seo.\nmore')).toEqual(['impeccable', 'seo'])
  expect(skillsNamed('- Skills to invoke: none')).toEqual([])
  expect(skillsNamed('no skills line')).toEqual([])
  expect(verdictOf('PASS a\nPASS b')).toMatchObject({ verdict: 'pass', pass: 2 })
  expect(verdictOf('PASS a\nNOT CHECKED b')).toMatchObject({ verdict: 'not checked' })
  expect(verdictOf('FAIL a')).toMatchObject({ verdict: 'fail' })
  // numbered and bold lines, as real verifier reports are written
  expect(verdictOf('Chat at 1b275ad.\n1. FAIL (partial). H1 ok\n2. PASS. Enter works\n- **NOT CHECKED**: figma')).toMatchObject({ verdict: 'fail', pass: 1, fail: 1, unchecked: 1 })
  expect(verdictOf('We pass the build and fail nothing')).toMatchObject({ verdict: 'not checked', pass: 0, fail: 0 })
  // a sentence after "Skills:" gives only its plugin:skill names
  expect(skillsNamed('Skills: Use n8n-mcp-skills:using-n8n-mcp-skills first with the Skill tool and follow its rules')).toEqual(['n8n-mcp-skills:using-n8n-mcp-skills'])
  // a launch line keeps the first non-empty line of the brief, cut to 120, and nothing else of it
  const l = launchLine(0, 1, { id: 'a', type: 'coder', model: 'm', effort: 'low', by: { model: 'router', effort: 'router' }, brief: `\n${'y'.repeat(300)}\nsecond`, skills: [] })
  expect(String(l.brief)).toHaveLength(120)
  expect(JSON.stringify(l)).not.toContain('second')
})

test('totals are summed from the lines, per model, with "prices missing" where a cost is null', () => {
  const lines = [
    taskLine(0, 1, 't', 'on'),
    mainLine(0, 1, { model: 'fable', effort: 'medium', in: 100, cached: 0, out: 10, cost: null, sec: 5 }),
    endLine(0, 1, { id: 'a', agent: 'scout', model: 'haiku', in: 50, cached: 5, out: 5, cost: null, sec: 2, turns: 2, end: 'ended' }),
  ]
  const t = totalsOf(lines)
  expect(t.main).toEqual({ in: 100, out: 10 })
  expect(t.agents).toEqual({ in: 50, out: 5 })
  expect(Object.keys(t.byModel)).toEqual(['fable', 'haiku'])
  expect(mdOf(lines)).toContain('- Cost: prices missing')
})
