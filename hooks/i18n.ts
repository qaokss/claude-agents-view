import type { AgentStatusWord, SkillStatus } from '../types'

// Every word the pane and its pictures show, in one place.

const enPlural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export type Words = {
  title: string
  commandDescription: string
  opened: string
  sessions: (n: number) => string
  list: string
  graph: string
  show: string
  plans: string
  agents: string
  skills: string
  allHidden: string
  allHiddenDot: string
  nothingYet: string
  statistics: string
  allTime: (sessions: number) => string
  noCallsYet: string
  noDataYet: string
  skillCalls: (n: number) => string
  agentRuns: (n: number) => string
  more: (n: number) => string
  fold: string
  replaced: string
  noDescription: string
  calls: (n: number) => string
  skillsCount: (n: number) => string
  usedSkills: (n: number) => string
  subagentsCount: (n: number) => string
  finishedSubagents: (n: number) => string
  pastPlans: (n: number) => string
  pastPlansWithAgents: (n: number, agents: number) => string
  untitled: string
  runningAgents: (n: number) => string
  otherSessions: (n: number) => string
  foldAll: string
  unfoldAll: string
  thisSession: string
  planCount: (done: number, total: number) => string
  sessionAlt: (name: string, steps: number, agents: number) => string
  pastPlanAlt: (steps: number) => string
  // pictures
  agentStatus: Record<AgentStatusWord, string>
  skillStatus: Record<SkillStatus, string>
  callsChip: string
  noTools: string
  toolCalls: (n: number) => string
  skillWord: string
  stepDropped: string
  thisSessionTip: string
  runningTip: (n: number) => string
  durationS: (s: number) => string
  // tokens & settings
  settings: string
  options: string
  showTokens: string
  tokens: (n: number) => string
  inContext: (n: number) => string
  waitingForYou: string
  // attention
  contextFull: (percent: number) => string
  compactsAt: (tokens: number) => string
  quietFor: (time: string) => string
  quietTip: string
  waitsToast: (name: string) => string
  notifyWhenWaiting: string
  openAtStart: string
  openButtonOption: string
  openPane: string
  openPaneWaiting: (n: number) => string
  openAgentHint: string
}

const en: Words = {
  title: 'Agents, skills & plans',
  commandDescription: 'Show what agents, skills and plans are doing',
  opened: 'Agents, skills & plans view opened.',
  sessions: n => `${n} ${enPlural(n, 'session', 'sessions')}`,
  list: 'List',
  graph: 'Graph',
  show: 'Show',
  plans: 'Plans',
  agents: 'Agents',
  skills: 'Skills',
  allHidden: 'Everything is filtered out',
  allHiddenDot: 'Everything is filtered out.',
  nothingYet: 'No plan, no subagents yet.',
  statistics: 'Statistics',
  allTime: n => `All time · ${n} ${enPlural(n, 'session', 'sessions')}`,
  noCallsYet: 'No calls yet',
  noDataYet: 'No data yet — it appears after the first skills and subagents',
  skillCalls: n => `Skills · ${n} ${enPlural(n, 'call', 'calls')}`,
  agentRuns: n => `Subagents · ${n} ${enPlural(n, 'run', 'runs')}`,
  more: n => `${n} more`,
  fold: 'collapse',
  replaced: 'replaced',
  noDescription: 'No description',
  calls: n => `${n} ${enPlural(n, 'call', 'calls')}`,
  skillsCount: n => `Skills · ${n}`,
  usedSkills: n => `Used skills (${n})`,
  subagentsCount: n => `Subagents · ${n}`,
  finishedSubagents: n => `Finished subagents (${n})`,
  pastPlans: n => `Past plans (${n})`,
  pastPlansWithAgents: (n, a) => `Past plans (${n})${a ? ` · ${a} ${enPlural(a, 'subagent', 'subagents')}` : ''}`,
  untitled: 'Untitled session',
  runningAgents: n => `${n} ${enPlural(n, 'subagent', 'subagents')} running`,
  otherSessions: n => `Other sessions · ${n}`,
  foldAll: 'collapse all',
  unfoldAll: 'expand all',
  thisSession: 'this session',
  planCount: (d, t) => `Plan · ${d}/${t}`,
  sessionAlt: (name, s, a) => `${name}: plan of ${s} steps, ${a} subagents`,
  pastPlanAlt: s => `Past plan: ${s} steps`,
  agentStatus: {
    pending: 'pending',
    running: 'running',
    waiting: 'waiting',
    idle: 'idle',
    completed: 'done',
    failed: 'failed',
    killed: 'stopped',
  },
  skillStatus: { active: 'active', used: 'used', failed: 'failed' },
  callsChip: 'calls',
  noTools: 'no tool calls',
  toolCalls: n => `tool calls: ${n}`,
  skillWord: 'skill',
  stepDropped: '(the plan was replaced before this step)',
  thisSessionTip: ' (this session)',
  runningTip: n => `${n} ${enPlural(n, 'subagent', 'subagents')} running`,
  durationS: s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`),
  settings: 'Settings',
  options: 'Options',
  showTokens: 'Show token usage',
  tokens: n => `${shortCount(n)} tokens`,
  inContext: n => `${shortCount(n)} in context`,
  waitingForYou: '● waiting for you',
  contextFull: p => `${p}% full`,
  compactsAt: n => `compacts at ${shortCount(n)}`,
  quietFor: time => `⚠ quiet ${time}`,
  quietTip: 'No tool calls for a while: it may be stuck.',
  waitsToast: name => `“${name}” is waiting for your answer`,
  notifyWhenWaiting: 'Notify when a session waits for me',
  openAtStart: 'Open this pane when a session starts',
  openButtonOption: 'Button above the prompt while it is closed',
  openPane: '◐ Agents, skills & plans',
  openPaneWaiting: n => `● ${n} waiting for you`,
  openAgentHint: 'Open its conversation',
}

/** 950 → «950», 142 812 → «142.8k», 1 520 000 → «1.52M». */
export const shortCount = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`

export const WORDS: Words = en
