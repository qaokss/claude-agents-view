export type AgentStatusWord =
  | 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** A frontier CLI other than Claude that Claude ran through Bash. */
export type ExternalVendor = 'codex' | 'gemini'

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
  /** Set on a card for a Codex or Gemini run, or for one of their own agents. */
  vendor?: ExternalVendor
  /** The model the CLI reported, for a vendor card. */
  model?: string
  /** The card this one hangs under: the Claude subagent that ran a CLI, or the run that started this agent. */
  parentId?: string
  /** When it last started or finished a tool call; with none in flight, a long quiet means it may be stuck. */
  activeAt?: number
  /** Its tool calls in flight. */
  busy?: number
}

/** A Bash call that runs a frontier CLI, as the pane follows its log. */
export type ExternalRun = {
  /** Its card's id: `ext:<tool_use_id>`. */
  id: string
  vendor: ExternalVendor
  cwd: string
  startedAt: number
  isBackground: boolean
  /** When the Bash call returned, for a run in the foreground. */
  returnedAt?: number
  returnedOk?: boolean
  /** The log of its main session, once found. */
  path?: string
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

export type PlanStep = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** When it went in progress. */
  startedAt?: number
  /** When it was checked off. */
  endedAt?: number
}

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
  /** That context as a share of the model's window, 0 to 100. */
  contextPercent?: number
  /** The token count at which auto-compaction runs; absent when it is off or not known yet. */
  compactAt?: number
  /** When the latest user message or plan began; finished agents from before it fold away in the graph. */
  turnAt?: number
  /** Since when a permission prompt or a question has waited on the user; absent when nothing does. */
  waitingAt?: number
}

export type SelfInfo = {
  sessionId: string
  title: string
  folder: string
  topic: string
}

/** The viewer's settings, from the pane's ⚙ card. */
export type PaneSettings = {
  tokens: boolean
  /** A toast when another session starts waiting on the user; absent counts as on. */
  notify?: boolean
  /** Open the pane when a session starts or a window attaches; absent counts as on. */
  autoOpen?: boolean
  /** A button above the prompt while the pane is closed; absent counts as on. */
  openButton?: boolean
}

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
      contextPercent: number
      compactAt: number
      runs: Shaped<ExternalRun[]>
      turnAt: number
      waitingAt: number
      paneShown: boolean
      closedByHand: boolean
    }
  }
}
