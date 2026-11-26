import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { markerOf } from '../hooks/register'

// File-based command stubs (commands/cr-*.md) for sessions that list only file commands: the expanded stub carries
// "[cr-cmd] cr-<name> <args>", skill.prompt sees it, and the same function as the runtime command runs.

const HOME = 'C:/Users/me'
const CWD = 'C:/work/site'
const CMD = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const FILES: Record<string, string> = {
  [`${HOME}/.claude/orchestrator.md`]: '# Orchestrator rules\nYou manage. You never read code.\n',
}

function world(on: On) {
  mock.clock(on)
  mock.env(on, { USERPROFILE: HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const text = FILES[e.path.split('\\').join('/')]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', () => ({ value: [] }))
  // The engine expands the stub's file; what comes back is what the model is given
  on('skill.prompt', (_$, e) => ({ text: e.text }))
}

const stub = (name: string, args: string) => ({ skill: `agent-ClaudeRouter:${name}`, text: `[cr-cmd] ${name} ${args}\n\nPrint the ClaudeRouter reply verbatim.` })
const replyOf = (text: string) => /<cr-reply command="[^"]+">\n([\s\S]*)\n<\/cr-reply>/.exec(text)?.[1] ?? null

test('marker: parses command and arguments, a literal $ARGUMENTS is no argument, /cr maps to cr-status', () => {
  expect(markerOf('[cr-cmd] cr-orchestrator off\nPrint it')).toEqual({ command: 'cr-orchestrator', args: 'off' })
  expect(markerOf('[cr-cmd] cr-status $ARGUMENTS')).toEqual({ command: 'cr-status', args: '' })
  expect(markerOf('[cr-cmd] cr-pin opus high')).toEqual({ command: 'cr-pin', args: 'opus high' })
  expect(markerOf('[cr-cmd] cr ')).toEqual({ command: 'cr-status', args: '' })
  expect(markerOf('just a prompt about [cr-cmd]')).toBeNull()
})

test('cr-status stub runs the same handler as /cr-status and the model gets its reply', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const runtime = (await $.command.run({ command: 'cr-status', args: '', ...CMD })).text ?? ''
  expect(runtime).toMatch(/orchestrator:/)
  const out = await $.skill.prompt(stub('cr-status', ''))
  expect(replyOf(out.text)).toBe(runtime)
  expect(out.text).toMatch(/verbatim/)
  expect(out.text).not.toMatch(/\[cr-cmd\]/)
})

test('cr-orchestrator off stub changes the option exactly as /cr-orchestrator off does', async ($, on) => {
  world(on)
  mock.session(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'cr-orchestrator', args: 'on', ...CMD })
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text).toMatch(/orchestrator: on \(manager only\)/)
  const out = await $.skill.prompt(stub('cr-orchestrator', 'off'))
  const reply = replyOf(out.text) ?? ''
  expect(reply).toMatch(/^orchestrator: off/)
  expect((await $.command.run({ command: 'cr-status', args: '', ...CMD })).text).toMatch(/orchestrator: off/)
  // The runtime command gives the same answer from the same state
  expect((await $.command.run({ command: 'cr-orchestrator', args: 'off', ...CMD })).text).toBe(reply)
})

test('a skill without the marker is left as it is', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const out = await $.skill.prompt({ skill: 'seo-audit', text: 'Audit the site.' })
  expect(out.text).toBe('Audit the site.')
})
