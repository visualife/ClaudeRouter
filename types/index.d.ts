// The state contract: every value ClaudeRouter keeps in $.state, declared under the mod's name

export type Model = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

// The latest routing decision, for the main conversation or one subagent request
export type Route = {
  model: Model
  effort: Effort
  conf: number
  kept: boolean
  engineModel: string
  source: 'main' | 'subagent'
  // The signals it was picked on, for the band's second line
  why: string
}

// A subagent of a task; its tokens and seconds arrive with its own turn.complete
export type Agent = {
  id: string | null
  name: string
  // The mascot it wears, from its type and task: scout, builder, researcher or planner
  role: 'scout' | 'builder' | 'researcher' | 'planner'
  model: string | null
  effort: Effort | null
  status: 'running' | 'done' | 'failed'
  startedAt: number
  seconds: number | null
  tokens: number
}

// One user turn. There is no total for it, so its bar shimmers until it ends.
// Its model and effort are the router's latest pick for it; its tokens arrive with turn.complete.
export type Task = {
  id: string
  name: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  seconds: number | null
  steps: number
  model: Model | null
  effort: Effort | null
  tokens: number | null
  agents: Agent[]
}

export type SkillUse = { name: string; uses: number }
export type McpUse = { server: string; tool: string; calls: number }

export type Usage = {
  startedAt: number
  context: { tokens: number | null; window: number; percent: number | null }
  rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[]
  cost: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-ClaudeRouter': {
      route: Route | null
      tasks: Task[]
      skills: SkillUse[]
      mcp: McpUse[]
      plugins: string[]
      usage: Usage | null
      totals: { tokens: number; turns: number }
    }
  }
}
