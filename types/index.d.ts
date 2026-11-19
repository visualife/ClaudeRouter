// The state contract: every value ClaudeRouter keeps in $.state, declared under the mod's name

// fable is picked by the router only for flagship creative work (the default creative setting); otherwise it is the user's own choice (/model, pin or @fable) and is left alone
export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
// max is never picked or pinned by the router: it only appears when an agent file or an Agent call set it
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
// Who chose a sub-agent's model or effort: the agent file (frontmatter), the Agent call of the orchestrating session,
// the router, an environment variable (CLAUDE_CODE_SUBAGENT_MODEL_FORCE, CLAUDE_CODE_EFFORT_LEVEL), or nobody
// (a fork, or an agent whose file the router could not read: the engine's own default stands and is left alone)
export type Source = 'frontmatter' | 'orchestrator' | 'router' | 'env' | 'default'
export type Who = { model: Source; effort: Source }
// Who picks the tier: the local keyword rules, or Jev (falls back to the rules when it is unreachable)
export type Engine = 'rules' | 'jev'

// The user's switches, set with /cr-* commands. warmUntil is a clock time in ms; 0 means keep-warm is off.
// pin/pinEffort: a model (and effort) forced on every main-thread request; null = the router decides.
// maxEffort: the highest effort the router may pick by itself. budget: USD one turn may spend before it is
// downgraded (0 = off). ctxCap: context tokens above which requests are downgraded (0 = off).
export type Options = {
  engine: Engine
  warmUntil: number
  pin: Model | null
  pinEffort: Effort | null
  maxEffort: Effort
  budget: number
  ctxCap: number
  // Locked models: when the session runs on one of them, its requests are passed through untouched (no rerouting,
  // no caps), unless a pin or an "@model" prefix says otherwise. An id the router does not know is always passed through.
  locks: Model[]
  // The band above the prompt: 'full' shows every row, 'route' only the task bar and the model route, 'off' closes it
  band: 'full' | 'route' | 'off'
  // Flagship creative work (identity, naming, taglines, art direction, campaign concepts): Opus at xhigh, Fable at
  // high, or 'off' to route creative prompts like any other. Craft copy stays on Opus high, bulk on Sonnet high.
  creative: 'opus' | 'fable' | 'off'
  // Highest effort creative work may run at. It replaces maxEffort for creative turns.
  creativeCap: Effort
  // on: the session is the orchestrator, manager only. Its model is left as chosen and never rerouted, a sub-agent that
  // nothing sets is routed instead of inheriting a locked parent's model, and the main thread's file and shell tools are
  // blocked (see managerBlock). hands: the same with the block lifted, for an emergency; the rules stay loaded. off: as before.
  orchestrator: 'on' | 'hands' | 'off'
  // Size in bytes of the orchestrator rules injected into the main session, or null when they are not loaded
  rules: number | null
}

// USD per million tokens, per model family. null = not filled in: the router never guesses a price.
export type Price = { input: number | null; output: number | null; cacheWrite: number | null; cacheRead: number | null }
export type Prices = Partial<Record<Model, Price>>

// The latest routing decision, for the main conversation or one subagent request
export type Route = {
  model: Model
  effort: Effort
  conf: number
  kept: boolean
  // Who made the pick; 'rules' also when Jev was asked and failed
  by: Engine
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
  // Uncached input plus output, as before: what the bars share
  tokens: number
  // The agent type it was spawned as (coder, scout, Explore, plugin:name), and who set its model and effort.
  // Optional: a task saved by an older version lacks them.
  type?: string
  by?: Who
  // Prompt tokens it was billed fresh (input + cache writes), prompt tokens the cache served, and tokens it wrote
  tokensIn?: number
  tokensCached?: number
  tokensOut?: number
  // Of tokensIn, the part that was cache writes (priced differently from fresh input)
  tokensWrite?: number
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
  tokensIn?: number
  tokensCached?: number
  tokensOut?: number
  tokensWrite?: number
  // Tool calls the manager guard refused on the main thread this turn: a high count means the rules need work
  blocks?: number
  agents: Agent[]
}

// What Jev has cost this session: calls made, and the last call's tokens against its 64k window
export type JevUse = { calls: number; input: number; output: number }

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
      options: Options
      jev: JevUse | null
      totals: { tokens: number; turns: number }
      // Session-start warnings: environment variables that override every model and effort choice
      warnings: string[]
      // The price table, from prices.json in the plugin and ~/.claude/clauderouter-prices.json
      prices: Prices
      // The session log's file (.jsonl), kept so a reload goes on writing the same one
      logfile: string | null
    }
  }
}
