export type AgentStatusWord =
  | 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type TrackedAgent = {
  id: string
  description: string
  type: string
  prompt: string
  status: AgentStatusWord
  startedAt: number
  endedAt?: number
  toolCalls: number
  lastTool?: string
  /** The plan step that was under way when the agent was spawned. */
  step?: string
  /** Calls per tool name. */
  tools?: Record<string, number>
  /** Tokens it has used, as the engine counts them: its latest request's input and all its output. */
  tokens?: number
}

export type SkillStatus = 'active' | 'used' | 'failed'

/** One skill as a session used it: repeated calls by the same caller under the same step count up. */
export type TrackedSkill = {
  id: string
  name: string
  args?: string
  /** The subagent that called it; absent for the main conversation. */
  by?: string
  /** The plan step under way when it was first called. */
  step?: string
  calledAt: number
  status: SkillStatus
  count: number
}

export type PlanStep = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type ArchivedPlan = { steps: PlanStep[]; endedAt: number }

export type SessionSnapshot = {
  sessionId: string
  title: string
  folder: string
  topic: string
  plan: PlanStep[]
  history: ArchivedPlan[]
  agents: TrackedAgent[]
  skills?: TrackedSkill[]
  updatedAt: number
  isEnded?: boolean
  /** Tokens in the main conversation's context window, after its last response. */
  contextTokens?: number
}

export type SelfInfo = {
  sessionId: string
  title: string
  folder: string
  topic: string
}

/** The viewer's settings, from the pane's ⚙ card. */
export type PaneSettings = { tokens: boolean }

/** What the viewer folded or unfolded; keys are `plan:<id>`, `done:<id>`, `session:<id>`. */
export type FoldState = { open: string[]; closed: string[] }

/** Usage summed over every session that ever ran the mod: calls per skill, runs per agent type. */
export type UsageStats = { skills: Record<string, number>; agents: Record<string, number>; sessions: number }

declare module 'claude-code' {
  interface PluginState {
    'subagents-pane': {
      agents: Shaped<TrackedAgent[]>
      now: number
      plan: Shaped<PlanStep[]>
      history: Shaped<ArchivedPlan[]>
      others: Shaped<SessionSnapshot[]>
      self: Shaped<SelfInfo>
      fold: Shaped<FoldState>
      view: 'list' | 'graph'
      skills: Shaped<TrackedSkill[]>
      shown: Shaped<{ plans: boolean; agents: boolean; skills: boolean }>
      stats: Shaped<UsageStats>
      settings: Shaped<PaneSettings>
      context: number
    }
  }
}
