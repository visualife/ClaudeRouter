import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import { clip, endLine, fromJsonl, launchLine, logPaths, mdOf, projectName, reviewPrompt, skillsNamed, taskLine, toJsonl, totalsOf, verdictOf, mainLine } from '../hooks/sessionlog'

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

function world(on: On) {
  const written: Record<string, string> = {}
  const spawned: { id: string }[] = []
  mock.clock(on, { now: Date.UTC(2026, 10, 18, 9, 30) })
  mock.env(on, { USERPROFILE: HOME, SOME_API_KEY: SECRET_ENV, CLAUDE_CODE_EFFORT_LEVEL: 'auto' })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId?: string }).sessionId ?? 'sess-1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const path = e.path.split('\\').join('/')
    const text = written[path] ?? FILES[path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    written[e.path.split('\\').join('/')] = e.text
    return { value: undefined }
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
  expect(path).toMatch(/^C:\/Users\/me\/\.claude\/cr-logs\/site\/2026-11-18-\d{4}-sess-1\.jsonl$/)
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

test('/cr-log shows this session as a table, /cr-log last the previous one', async ($, on) => {
  const written = world(on)
  // an earlier session of the same project
  const earlier = `${HOME}/.claude/cr-logs/site/2026-11-17-1000-old.jsonl`
  written[earlier] = toJsonl([{ t: 'session', at: 1, phase: 'start', project: 'site', mode: 'off' }, taskLine(2, 1, 'old task', 'off')])
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', text: 'new task' })
  const now = (await $.command.run({ command: 'cr-log', args: '', ...CMD })).text ?? ''
  expect(now).toMatch(/## Task 1 · new task/)
  expect(now).not.toMatch(/old task/)
  const last = (await $.command.run({ command: 'cr-log', args: 'last', ...CMD })).text ?? ''
  expect(last).toMatch(/## Task 1 · old task/)
  expect(last).toContain('2026-11-17-1000-old.jsonl')
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
  expect(prompt).toContain('Read only these 2 files')
  expect(prompt).toContain('/a/2.jsonl')
  expect(prompt).toMatch(/at most five proposed changes/i)
  expect(prompt).toMatch(/You change nothing and write no file/)
})

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────────────────

test('names, paths and cuts', () => {
  expect(projectName('C:\\Users\\me\\Documents\\ClaudeCodeProjects\\locationsite')).toBe('locationsite')
  expect(logPaths('C:\\Users\\me', '/p/site', Date.UTC(2026, 10, 18, 9, 30), 'abc').jsonl).toMatch(/^C:\/Users\/me\/\.claude\/cr-logs\/site\/2026-11-18-\d{4}-abc\.jsonl$/)
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
