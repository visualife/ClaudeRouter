import type { Agent, McpUse, SkillUse, Task, Usage } from '../types'

// Pure list and value helpers the hooks use. No mods API calls here.

// The session usage the engine reports, in ClaudeRouter's shape
export type RawUsage = {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

export function toUsage(raw: RawUsage): Usage {
  return {
    startedAt: raw.startedAt,
    context: { tokens: raw.context.tokens ?? null, window: raw.context.window, percent: raw.context.percent ?? null },
    rateLimits: raw.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null })),
    cost: raw.cost?.usd ?? null,
  }
}

// A task's name is its prompt, shortened to one line
export function nameOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'prompt'
}

export function bumpSkill(list: SkillUse[], name: string): SkillUse[] {
  const hit = list.find(s => s.name === name)
  if (!hit) return [...list.slice(-7), { name, uses: 1 }]
  return list.map(s => (s === hit ? { ...s, uses: s.uses + 1 } : s))
}

export function bumpMcp(list: McpUse[], server: string, tool: string): McpUse[] {
  const hit = list.find(m => m.server === server && m.tool === tool)
  if (!hit) return [...list.slice(-7), { server, tool, calls: 1 }]
  return list.map(m => (m === hit ? { ...m, calls: m.calls + 1 } : m))
}

export function addPlugin(list: string[], name: string): string[] {
  return list.includes(name) ? list : [...list, name]
}

export function attachAgent(list: Task[], taskId: string, agent: Agent): Task[] {
  return list.map(t => (t.id === taskId ? { ...t, agents: [...t.agents, agent] } : t))
}

export function patchAgent(list: Task[], agentId: string, patch: Partial<Agent>): Task[] {
  return list.map(t => ({
    ...t,
    agents: t.agents.map(a => (a.id === agentId ? { ...a, ...patch } : a)),
  }))
}

export function patchTask(list: Task[], taskId: string, patch: Partial<Task>): Task[] {
  return list.map(t => (t.id === taskId ? { ...t, ...patch } : t))
}
