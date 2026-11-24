import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type {
  AgentStatusWord,
  ArchivedPlan,
  ExternalRun,
  FoldState,
  PaneSettings,
  PlanStep,
  SelfInfo,
  SessionSnapshot,
  TrackedAgent,
  TrackedSkill,
  UsageStats,
} from '../types'
import { assignAgents, contextWarning, bodyPicture, earlierPicture, groupDigits, isStalled, quietMs, splitLoose, headerPicture, planPicture, rankingPicture, shortSkill, stepTime } from './graph'
import type { Picture, SessionState, Show } from './graph'
import { WORDS } from './i18n'
import { VENDOR_NAME, isFollowed, pollRuns, runDir, vendorOf } from './external'

const w = WORDS

const PANE = 'subagents'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const agents = atom({ plugin: 'subagents-pane', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const plan = atom({ plugin: 'subagents-pane', key: 'plan' } as const, [], {
  shape: 'plan-1',
})
const history = atom({ plugin: 'subagents-pane', key: 'history' } as const, [], {
  shape: 'history-1',
})
const HISTORY_MAX = 20
const others = atom({ plugin: 'subagents-pane', key: 'others' } as const, [], {
  shape: 'others-3',
})
const EMPTY_SELF: SelfInfo = { sessionId: '', title: '', folder: '', topic: '' }
const self = atom({ plugin: 'subagents-pane', key: 'self' } as const, EMPTY_SELF, {
  shape: 'self-3',
})
const EMPTY_FOLD: FoldState = { open: [], closed: [] }
const fold = atom({ plugin: 'subagents-pane', key: 'fold' } as const, EMPTY_FOLD, {
  shape: 'fold-1',
})
const skills = atom({ plugin: 'subagents-pane', key: 'skills' } as const, [], {
  shape: 'skills-1',
})
const SKILLS_MAX = 60
const shownAtom = atom(
  { plugin: 'subagents-pane', key: 'shown' } as const,
  { plans: true, agents: true, skills: true },
  { shape: 'shown-1' },
)
const EMPTY_STATS: UsageStats = { skills: {}, agents: {}, sessions: 0 }
const stats = atom({ plugin: 'subagents-pane', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-2' })
const view = atom({ plugin: 'subagents-pane', key: 'view' } as const, 'list' as 'list' | 'graph')
const DEFAULT_SETTINGS: PaneSettings = { tokens: true }
const settings = atom({ plugin: 'subagents-pane', key: 'settings' } as const, DEFAULT_SETTINGS, {
  shape: 'settings-1',
})
// Tokens in this session's context window after its last response.
const context = atom({ plugin: 'subagents-pane', key: 'context' } as const, 0)
// That context as a share of the model's window, 0 to 100.
const contextPercent = atom({ plugin: 'subagents-pane', key: 'contextPercent' } as const, 0)
// The token count at which auto-compaction runs (0: off, or not known yet).
const compactAt = atom({ plugin: 'subagents-pane', key: 'compactAt' } as const, 0)
// Codex and Gemini runs Claude started through Bash, followed by their logs.
const runs = atom({ plugin: 'subagents-pane', key: 'runs' } as const, [], { shape: 'runs-1' })
const RUNS_MAX = 30
// When the user last sent a message, or a new plan replaced the old one.
const turnAt = atom({ plugin: 'subagents-pane', key: 'turnAt' } as const, 0)
// Since when a permission prompt or a question waits on the user (0: nothing does).
const waitingAt = atom({ plugin: 'subagents-pane', key: 'waitingAt' } as const, 0)
const now = atom({ plugin: 'subagents-pane', key: 'now' } as const, 0)
// Whether the pane is drawn and in front: the button above the prompt shows when it is not.
const paneShown = atom({ plugin: 'subagents-pane', key: 'paneShown' } as const, false)
// The person closed the pane in this session: a window attaching does not reopen it.
const closedByHand = atom({ plugin: 'subagents-pane', key: 'closedByHand' } as const, false)

// Newer engines count each agent's tokens on its row; older ones leave it out.
const tokenCountOf = (info: object) => {
  const n = (info as { tokenCount?: unknown }).tokenCount
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

const LIVE: AgentStatusWord[] = ['pending', 'running', 'waiting', 'idle']
const isLive = (a: TrackedAgent) => LIVE.includes(a.status)

const AGENT_ICON: Record<AgentStatusWord, string> = {
  pending: '◌',
  running: '◐',
  waiting: '◔',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '⊘',
}
const COLOR: Record<AgentStatusWord, string> = {
  pending: 'subtle',
  running: 'claude',
  waiting: 'warning',
  idle: 'suggestion',
  completed: 'success',
  failed: 'error',
  killed: 'inactive',
}

const INTERNAL_TOOLS: string[] = ['SubagentHandback']
const SKILL_ICON: Record<TrackedSkill['status'], string> = { active: '◆', used: '◇', failed: '◇' }
const SKILL_COLOR: Record<TrackedSkill['status'], string> = { active: 'claude', used: 'subtle', failed: 'error' }
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode']
const WAIT_SHOWN_MS = 2_000

const STEP_ICON: Record<PlanStep['status'], string> = {
  pending: '◌',
  in_progress: '◐',
  completed: '✓',
}
const STEP_COLOR: Record<PlanStep['status'], string> = {
  pending: 'subtle',
  in_progress: 'claude',
  completed: 'success',
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

// Text the app wraps around a prompt (reminders, notices) is not what the person
// typed, so it never names a session. Applied when the topic is taken and when it
// is drawn, since older versions stored it as is.
const HARNESS_TAG = String.raw`(?:system-reminder|task-notification|side-sessions-event|ci-monitor-event|local-command-[\w-]+|command-[\w-]+|ide_[\w-]+)`
const topicFrom = (s: string, max: number) => {
  const text = s
    .replace(new RegExp(String.raw`<(${HARNESS_TAG})\b[^>]*>[\s\S]*?</\1>`, 'g'), ' ')
    .replace(new RegExp(String.raw`<${HARNESS_TAG}\b[\s\S]*$`), ' ')
    .replace(/<\/?[a-zA-Z][\w-]*[^>]*>/g, ' ')
  return oneLine(text, max)
}

// 2:14, or 1:02:14 past the hour.
const clockTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}


const isStatus = (v: unknown): v is PlanStep['status'] =>
  v === 'pending' || v === 'in_progress' || v === 'completed'

// Replays one update_plan call onto the steps, as the app reads it.
const applyPlanCall = (steps: PlanStep[], args: Record<string, unknown>): PlanStep[] => {
  if (Array.isArray(args.items)) {
    return args.items.flatMap(item => {
      const it = item as { content?: unknown; status?: unknown }
      return typeof it.content === 'string'
        ? [{ content: it.content, status: isStatus(it.status) ? it.status : 'pending' }]
        : []
    })
  }
  let next = steps.map(s => ({ ...s }))
  if (args.advance === true) {
    const cur = next.findIndex(s => s.status === 'in_progress')
    if (cur >= 0) next[cur]!.status = 'completed'
    const nxt = next.findIndex((s, i) => i > cur && s.status === 'pending')
    if (nxt >= 0) next[nxt]!.status = 'in_progress'
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) {
      if (typeof n === 'number' && next[n - 1]) next[n - 1]!.status = 'completed'
    }
  }
  if (typeof args.start === 'number' && next[args.start - 1]) {
    next = next.map(s => (s.status === 'in_progress' ? { ...s, status: 'pending' } : s))
    next[args.start - 1]!.status = 'in_progress'
  }
  return next
}

// Carries each step's times over a plan call and stamps the changes: a step
// that goes in progress starts now, one checked off ends now.
const stampTimes = (old: PlanStep[], steps: PlanStep[], t: number): PlanStep[] =>
  steps.map((st, i) => {
    const was = old[i]?.content === st.content ? old[i] : old.find(o => o.content === st.content)
    const startedAt = st.startedAt ?? was?.startedAt ?? (st.status === 'in_progress' ? t : undefined)
    const endedAt = st.status === 'completed' ? (st.endedAt ?? was?.endedAt ?? (startedAt ? t : undefined)) : undefined
    const next: PlanStep = { content: st.content, status: st.status }
    if (startedAt && st.status !== 'pending') next.startedAt = startedAt
    if (endedAt) next.endedAt = endedAt
    return next
  })

// ---- the chat's title -------------------------------------------------------

// The app keeps each chat's name in `<projects>/<folder>/<sessionId>/custom-title.json`
// as `{"customTitle":"…"}`. Any session's name is read this way, by its id, so
// the pane names other sessions even when they run an older copy of the mod.
const TITLE_EVERY_MS = 15_000
const titleFiles = new Map<string, string>()
const titles = new Map<string, { title: string; at: number }>()

const findTitleFile = async ($: EngineInterface, sessionId: string) => {
  const known = titleFiles.get(sessionId)
  if (known) return known
  const home = await $.env.get('HOME')
  const projects = `${home ?? ''}/.claude/projects`
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    const candidate = `${projects}/${dir.name}/${sessionId}/custom-title.json`
    if (await $.fs.exists(candidate)) {
      titleFiles.set(sessionId, candidate)
      return candidate
    }
  }
  return ''
}

// The chat's name, re-read at most every 15 seconds; '' while it has none.
const titleOf = async ($: EngineInterface, sessionId: string, t: number) => {
  const cached = titles.get(sessionId)
  if (cached && t - cached.at < TITLE_EVERY_MS) return cached.title
  let title = cached?.title ?? ''
  try {
    const file = await findTitleFile($, sessionId)
    if (file) {
      const row = JSON.parse(await $.fs.read(file)) as { customTitle?: unknown }
      if (typeof row.customTitle === 'string' && row.customTitle.trim()) {
        title = row.customTitle.trim()
      }
    }
  } catch {
    // keep what was known
  }
  titles.set(sessionId, { title, at: t })
  return title
}

const refreshTitle = async ($: EngineInterface, t: number) => {
  const me = await read($, self)
  if (!me.sessionId) return
  const title = await titleOf($, me.sessionId, t)
  if (title && title !== me.title) await update($, self, m => ({ ...m, title }))
}

// ---- this session's own agents ----------------------------------------------

// Never lets a failed write hold up the agent's own work.
const patch = ($: EngineInterface, id: string, fn: (a: TrackedAgent) => TrackedAgent) =>
  update($, agents, list => list.map(a => (a.id === id ? fn(a) : a))).catch(() => {})

// Pulls the engine's own view of each agent's status into the pane.
const sync = async ($: EngineInterface) => {
  const listed = await $.agent.list()
  const t = await $.clock.now()
  const before = await read($, agents)
  const byId = new Map(before.map(a => [a.id, a]))
  let changed = false
  for (const info of listed) {
    if (info.teammateId) continue
    const known = byId.get(info.id)
    if (!known) {
      byId.set(info.id, {
        id: info.id,
        description: info.description,
        type: info.type,
        prompt: '',
        status: info.status,
        startedAt: t,
        toolCalls: 0,
        ...(tokenCountOf(info) > 0 ? { tokens: tokenCountOf(info) } : {}),
      })
      changed = true
    } else {
      let next = known
      if (known.status !== info.status) {
        const ended = !LIVE.includes(info.status)
        next = { ...next, status: info.status, endedAt: ended ? (known.endedAt ?? t) : undefined }
      }
      // The engine reads an agent's tokens every few seconds; a finished one
      // keeps its last count after its row is gone.
      // a new count means it answered a request: it is not stuck
      if (tokenCountOf(info) > 0 && tokenCountOf(info) !== known.tokens) next = { ...next, tokens: tokenCountOf(info), activeAt: t }
      if (next !== known) {
        byId.set(info.id, next)
        changed = true
      }
    }
  }
  if (changed) await update($, agents, () => [...byId.values()].slice(-100))
}

const track = async (
  $: EngineInterface,
  e: { description: string; subagentType: string; prompt: string },
  agentId: string,
) => {
  const t = await $.clock.now()
  const stepNow = (await read($, plan)).find(st => st.status === 'in_progress')
  const tracked: TrackedAgent = {
    ...(stepNow ? { step: stepNow.content } : {}),
    id: agentId,
    description: e.description,
    type: e.subagentType,
    prompt: oneLine(e.prompt, 300),
    status: 'running',
    startedAt: t,
    activeAt: t,
    toolCalls: 0,
  }
  // A resumed agent (SendMessage to it) keeps its record: its tool counts,
  // its step, its start; it is running again.
  await update($, agents, list => {
    const known = list.find(a => a.id === tracked.id)
    if (known) {
      return list.map(a => (a.id === tracked.id ? { ...a, status: 'running' as const, endedAt: undefined, activeAt: t } : a))
    }
    return [...list, tracked].slice(-100)
  })
  await update($, now, () => t)
}

// ---- sharing between sessions -----------------------------------------------

// Every session writes its snapshot here; the pane reads them all.
const sharedDir = async ($: EngineInterface) => {
  const home = await $.env.get('HOME')
  return `${home ?? '/tmp'}/.claude/mods-data/subagents-pane/sessions`
}
const STALE_MS = 90_000
const HEARTBEAT_MS = 30_000
let lastJson = ''
let lastWrite = 0

const snapshotOf = async ($: EngineInterface, t: number, isEnded = false): Promise<SessionSnapshot> => {
  const me = await read($, self)
  return {
    sessionId: me.sessionId,
    title: me.title,
    folder: me.folder,
    topic: me.topic,
    plan: await read($, plan),
    history: (await read($, history)).slice(-10),
    agents: (await read($, agents)).slice(-40),
    skills: (await read($, skills)).slice(-30),
    updatedAt: t,
    ...((await read($, context)) > 0 ? { contextTokens: await read($, context) } : {}),
    ...((await read($, contextPercent)) > 0 ? { contextPercent: await read($, contextPercent) } : {}),
    ...((await read($, compactAt)) > 0 ? { compactAt: await read($, compactAt) } : {}),
    ...((await read($, turnAt)) > 0 ? { turnAt: await read($, turnAt) } : {}),
    ...((await read($, waitingAt)) > 0 ? { waitingAt: await read($, waitingAt) } : {}),
    ...(isEnded ? { isEnded: true } : {}),
  }
}

const publish = async ($: EngineInterface, t: number, isEnded = false) => {
  const snap = await snapshotOf($, t, isEnded)
  if (!snap.sessionId) return
  const json = JSON.stringify({ ...snap, updatedAt: 0 })
  if (!isEnded && json === lastJson && t - lastWrite < HEARTBEAT_MS) return
  await $.fs.write(`${await sharedDir($)}/${snap.sessionId}.json`, JSON.stringify(snap))
  lastJson = json
  lastWrite = t
}

// Usage over all time: every Skill and Agent call in every transcript on the
// machine (subagents' own transcripts included). A call is written to a
// transcript more than once, so calls are told apart by their tool_use id.
const CALL_PATTERN =
  '"id":"toolu_[A-Za-z0-9_]+","name":"(Skill|Agent)","input":\\{"[a-z_]+":"[^"]*"(,"[a-z_]+":"[^"]*")?'
const countCalls = (grepOut: string): Omit<UsageStats, 'sessions'> => {
  const seen = new Set<string>()
  const out: Omit<UsageStats, 'sessions'> = { skills: {}, agents: {} }
  for (const line of grepOut.split('\n')) {
    const id = /"id":"(toolu_[A-Za-z0-9_]+)"/.exec(line)?.[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (line.includes('"name":"Skill"')) {
      const name = /"skill":"([^"]+)"/.exec(line)?.[1]
      if (name) out.skills[name] = (out.skills[name] ?? 0) + 1
    } else {
      const type = /"subagent_type":"([^"]+)"/.exec(line)?.[1] ?? 'general-purpose'
      out.agents[type] = (out.agents[type] ?? 0) + 1
    }
  }
  return out
}
let lastStatsRead = 0
const STATS_EVERY_MS = 30_000
const readStats = async ($: EngineInterface, t: number) => {
  if (t - lastStatsRead < STATS_EVERY_MS) return
  lastStatsRead = t
  const home = await $.env.get('HOME')
  const projects = `${home ?? ''}/.claude/projects`
  if (!(await $.fs.exists(projects))) return
  const ran = await $.process.run(['grep', '-rhoE', CALL_PATTERN, '--include=*.jsonl', projects], {
    timeoutMs: 20_000,
  })
  let sessions = 0
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    for (const f of await $.fs.list(`${projects}/${dir.name}`)) if (f.kind === 'file' && f.name.endsWith('.jsonl')) sessions++
  }
  const sum: UsageStats = { ...countCalls(ran.stdout), sessions }
  const before = await read($, stats)
  if (JSON.stringify(before) !== JSON.stringify(sum)) await update($, stats, () => sum)
}

// The app restarts a session's process with empty state: take back what this
// session last published. Subagents still marked live did not survive it.
const restore = async ($: EngineInterface, sessionId: string) => {
  if ((await read($, plan)).length || (await read($, agents)).length) return
  const path = `${await sharedDir($)}/${sessionId}.json`
  if (!(await $.fs.exists(path))) return
  let snap: SessionSnapshot
  try {
    snap = JSON.parse(await $.fs.read(path)) as SessionSnapshot
  } catch {
    return
  }
  if (snap.sessionId !== sessionId) return
  const at = snap.updatedAt || 0
  await update($, plan, () => snap.plan ?? [])
  await update($, history, () => snap.history ?? [])
  await update($, skills, () => snap.skills ?? [])
  await update($, agents, () =>
    (snap.agents ?? []).map(a => (isLive(a) ? { ...a, status: 'killed' as const, endedAt: a.endedAt ?? at, busy: 0 } : a)),
  )
  await update($, self, me => ({ ...me, title: me.title || snap.title || '', topic: me.topic || snap.topic || '' }))
}

// A session whose snapshot was already overwritten empty: replay its plan
// calls from its transcript, `<projects>/<folder>/<sessionId>.jsonl`.
const restorePlanFromTranscript = async ($: EngineInterface, sessionId: string) => {
  if ((await read($, plan)).length) return
  const home = await $.env.get('HOME')
  const projects = `${home ?? ''}/.claude/projects`
  if (!(await $.fs.exists(projects))) return
  let file = ''
  for (const dir of await $.fs.list(projects)) {
    if (dir.kind !== 'dir') continue
    const candidate = `${projects}/${dir.name}/${sessionId}.jsonl`
    if (await $.fs.exists(candidate)) {
      file = candidate
      break
    }
  }
  if (!file) return
  const ran = await $.process.run(['grep', '-hE', `"name":"(${PLAN_TOOL}|${WRAP_TOOL})"`, file], { timeoutMs: 10_000 })
  let steps: PlanStep[] = []
  const past: ArchivedPlan[] = []
  for (const line of ran.stdout.split('\n')) {
    let entry: { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue
    const at = Date.parse(entry.timestamp ?? '') || 0
    for (const part of entry.message.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (part.type !== 'tool_use' || (part.name !== PLAN_TOOL && part.name !== WRAP_TOOL)) continue
      const args = part.input ?? {}
      if (part.name === PLAN_TOOL && Array.isArray(args.items) && steps.length) past.push({ steps, endedAt: at })
      const next =
        part.name === WRAP_TOOL ? steps.map((s): PlanStep => ({ ...s, status: 'completed' })) : applyPlanCall(steps, args)
      steps = at ? stampTimes(steps, next, at) : next
    }
  }
  if (!steps.length) return
  await update($, plan, cur => (cur.length ? cur : steps))
  await update($, history, cur => (cur.length ? cur : past.slice(-HISTORY_MAX)))
}

const gather = async ($: EngineInterface, t: number) => {
  const dir = await sharedDir($)
  const me = await read($, self)
  if (!(await $.fs.exists(dir))) return
  const found: SessionSnapshot[] = []
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json') || entry.name === `${me.sessionId}.json`) continue
    if (t - entry.mtimeMs > STALE_MS) continue
    try {
      const snap = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as SessionSnapshot
      if (!snap.isEnded && t - snap.updatedAt < STALE_MS) found.push({
          ...snap,
          skills: snap.skills ?? [],
          title: (await titleOf($, snap.sessionId, t)) || snap.title || '',
          history: snap.history ?? [],
        })
    } catch {
      // a file mid-write or broken: skip it this round
    }
  }
  // sessions at work first (a subagent running, or a plan step in progress), then by folder
  const isWorking = (snap: SessionSnapshot) =>
    snap.agents.some(a => LIVE.includes(a.status)) || snap.plan.some(st => st.status === 'in_progress')
  found.sort(
    (a, b) =>
      Number(isWorking(b)) - Number(isWorking(a)) ||
      a.folder.localeCompare(b.folder) ||
      a.sessionId.localeCompare(b.sessionId),
  )
  const before = await read($, others)
  if (JSON.stringify(before) !== JSON.stringify(found)) await update($, others, () => found)
}

// The main conversation's context, as the status line counts it.
const readContext = async ($: EngineInterface) => {
  const usage = (await $.session.usage()).context
  const tokens = usage.tokens ?? 0
  const percent = usage.percent ?? 0
  if (tokens !== (await read($, context))) await update($, context, () => tokens)
  if (percent !== (await read($, contextPercent))) await update($, contextPercent, () => percent)
}

// Where auto-compaction runs: the /context breakdown, estimated locally (no
// API call), read once a minute since it changes only with the model or settings.
const COMPACT_EVERY_MS = 60_000
let lastCompactRead = -Infinity
const readCompactAt = async ($: EngineInterface, t: number) => {
  if (t - lastCompactRead < COMPACT_EVERY_MS) return
  lastCompactRead = t
  const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (!b) return
  const at = b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? 0) : 0
  if (at !== (await read($, compactAt))) await update($, compactAt, () => at)
}

// Reads the logs of the Codex and Gemini runs still followed, every few
// seconds, and writes their cards (and their own agents' cards) into the list.
const RUNS_EVERY_MS = 3_000
let lastRunsRead = 0
const lastCards = new Map<string, TrackedAgent[]>()
const followRuns = async ($: EngineInterface, t: number) => {
  if (t - lastRunsRead < RUNS_EVERY_MS) return
  lastRunsRead = t
  const all = await read($, runs)
  const followed = all.filter(r => isFollowed(r, lastCards.get(r.id), t)).map(r => ({ ...r }))
  if (followed.length === 0) return
  const cards = await pollRuns($, followed, t)
  for (const [id, list] of cards) lastCards.set(id, list)
  const paths = new Map(followed.filter(r => r.path).map(r => [r.id, r.path!]))
  if (all.some(r => paths.has(r.id) && r.path !== paths.get(r.id))) {
    await update($, runs, list => list.map(r => (paths.has(r.id) ? { ...r, path: paths.get(r.id) } : r)))
  }
  const typeOf = (c: TrackedAgent) => (c.vendor ? `${VENDOR_NAME[c.vendor]}${c.model ? ` · ${c.model}` : ''}` : c.type)
  await update($, agents, list => {
    const byId = new Map(list.map(a => [a.id, a]))
    let changed = false
    for (const group of cards.values()) {
      for (const c of group) {
        const known = byId.get(c.id)
        // the run's own card keeps what the Bash call gave it
        const next: TrackedAgent = known
          ? {
              ...known,
              status: c.status,
              endedAt: c.endedAt,
              ...(c.tokens ? { tokens: c.tokens } : {}),
              ...(c.model ? { model: c.model } : {}),
              ...(c.description && !known.description ? { description: c.description } : {}),
            }
          : { ...c, description: c.description || '' }
        next.type = typeOf(next)
        if (JSON.stringify(next) !== JSON.stringify(known)) {
          byId.set(c.id, next)
          changed = true
        }
      }
    }
    return changed ? [...byId.values()].slice(-100) : list
  })
}

// A prompt that waits a moment is the person's to answer (auto mode settles
// its own asks in well under that); a session waiting outranks working.
const stateOfSession = (snap: SessionSnapshot, t: number): SessionState =>
  snap.waitingAt && t - snap.waitingAt >= WAIT_SHOWN_MS
    ? 'waiting'
    : snap.agents.some(isLive) || snap.plan.some(st => st.status === 'in_progress')
      ? 'working'
      : 'idle'

const nameOfSession = (snap: SessionSnapshot) => snap.title || topicFrom(snap.topic ?? '', 60) || w.untitled

// Other sessions, outside the pane: a toast when one starts waiting on the person.
const toasted = new Map<string, number>()
// 0.5.0 counted sessions in the status line; clear what it left there.
let statusCleared = false
const tellOthers = async ($: EngineInterface, t: number) => {
  const prefs = await read($, settings)
  const list = await read($, others)
  const states = list.map(o => ({ o, state: stateOfSession(o, t) }))
  if (prefs.notify !== false) {
    for (const { o, state } of states) {
      if (state !== 'waiting' || toasted.get(o.sessionId) === o.waitingAt) continue
      toasted.set(o.sessionId, o.waitingAt!)
      $.ui.toast(w.waitsToast(oneLine(nameOfSession(o), 50)), { timeoutMs: 8_000 })
    }
  }
  if (!statusCleared) {
    statusCleared = true
    $.ui.status(undefined)
  }
}

// Something now waits on the person: the frame knocks once it has waited a moment.
const markWaiting = async ($: EngineInterface) => {
  try {
    const t = await $.clock.now()
    await update($, waitingAt, cur => cur || t)
  } catch {
    // the frame just won't blink
  }
}

// ---- opening the pane ----------------------------------------------------------

const notePane = async ($: EngineInterface) => {
  const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
  if (shown !== (await read($, paneShown))) await update($, paneShown, () => shown)
}

// Unasked: at the start, or when a window attaches, unless switched off or closed by hand.
const openOnItsOwn = async ($: EngineInterface) => {
  if ((await read($, settings)).autoOpen === false || (await read($, closedByHand))) return
  await $.ui.open({ id: PANE, title: w.title })
  await notePane($).catch(() => {})
}

// Asked: a command or a press, placed at any width.
const openAsked = async ($: EngineInterface) => {
  await update($, closedByHand, () => false)
  await $.ui.open({ id: PANE, title: w.title })
  await notePane($).catch(() => {})
}

const tick = async ($: EngineInterface) => {
  await sync($).catch(() => {})
  await readContext($).catch(() => {})
  await readCompactAt($, await $.clock.now()).catch(() => {})
  await followRuns($, await $.clock.now()).catch(() => {})
  const t = await $.clock.now()
  await refreshTitle($, t).catch(() => {})
  await publish($, t).catch(() => {})
  await gather($, t).catch(() => {})
  await tellOthers($, t).catch(() => {})
  await notePane($).catch(() => {})
  if (isOpen(await read($, fold), 'stats', false)) await readStats($, t).catch(() => {})
  else lastStatsRead = 0
  const anyLive =
    (await read($, agents)).some(isLive) ||
    (await read($, waitingAt)) > 0 ||
    (await read($, others)).some(o => o.agents.some(isLive) || !!o.waitingAt)
  if (anyLive) await update($, now, () => t)
}

// ---- folding ----------------------------------------------------------------

// A section is open when the viewer opened it, closed when they closed it,
// else as its default says.
const isOpen = (f: FoldState, key: string, byDefault: boolean) =>
  f.open.includes(key) ? true : f.closed.includes(key) ? false : byDefault

const setOpen = (f: FoldState, key: string, open: boolean): FoldState => ({
  open: open ? [...f.open.filter(k => k !== key), key] : f.open.filter(k => k !== key),
  closed: open ? f.closed.filter(k => k !== key) : [...f.closed.filter(k => k !== key), key],
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'subagents', description: w.commandDescription })
    await $.command.register({ name: 'agents-view', description: w.commandDescription })
    try {
      const sessionId = await $.session.id()
      const folder = e.cwd.split('/').filter(Boolean).pop() ?? e.cwd
      await update($, self, me => ({ ...me, sessionId, folder }))
      await restore($, sessionId)
      await restorePlanFromTranscript($, sessionId).catch(() => {})
    } catch {
      // without an id this session just isn't shared
    }
    void openOnItsOwn($).catch(() => {})
    $.clock.every(1000, () => void tick($).catch(() => {}))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const t = await $.clock.now()
      await update($, turnAt, () => t)
      await update($, waitingAt, () => 0)
    } catch {
      // folding is cosmetic
    }
    try {
      const me = await read($, self)
      const topic = topicFrom(me.topic, 60) ? '' : topicFrom(e.text, 60)
      if (topic) await update($, self, m => ({ ...m, topic }))
    } catch {
      // the topic is a label only
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await publish($, await $.clock.now(), true)
    } catch {
      // the file goes stale on its own
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    void openOnItsOwn($).catch(() => {})
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      if (e.origin.kind === 'person') await update($, closedByHand, () => true)
      await update($, paneShown, () => false)
    }
    return next(e)
  })

  // A button above the prompt opens the pane while it is closed or behind another.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prefs = await read($, settings)
    if (prefs.openButton === false || e.props.hasSurvey || (await read($, paneShown))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await $.clock.now()
    const waiting = (await read($, others)).filter(o => stateOfSession(o, t) === 'waiting').length
    return (
      <Box key="open-pane-band" flexDirection="row" gap={1}>
        <Button key="btn-open-pane" plain hover={{ color: 'text' }} onPress={() => void openAsked($).catch(() => {})}>
          <Text size="footnote" color="subtle">
            {w.openPane}
          </Text>
        </Button>
        {waiting > 0 ? (
          <Text size="footnote" color="warning">
            {w.openPaneWaiting(waiting)}
          </Text>
        ) : null}
      </Box>
    )
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await openAsked($)

    return { text: w.opened }
  })

  // The same pane under the plugin's new name; /subagents stays for habit.
  on('command.run', { command: 'agents-view' }, async $ => {
    await openAsked($)

    return { text: w.opened }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if ('agentId' in result && result.agentId && e.subagentType !== 'teammate') {
      try {
        await track($, e, result.agentId)
      } catch {
        // the pane misses this one; the spawn itself goes on
      }
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      const t = await $.clock.now().catch(() => 0)
      await patch($, e.agentId, a => ({ ...a, status: 'running', endedAt: undefined, ...(t ? { activeAt: t } : {}) }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // When a turn ends, the skills its caller worked under are done with.
    try {
      await update($, skills, list =>
        list.some(k => k.status === 'active' && k.by === e.agentId)
          ? list.map(k => (k.status === 'active' && k.by === e.agentId ? { ...k, status: 'used' as const } : k))
          : list,
      )
    } catch {
      // best-effort
    }
    if (e.agentId) {
      const t = await $.clock.now().catch(() => 0)
      const status: AgentStatusWord =
        e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      await patch($, e.agentId, a => ({ ...a, status, endedAt: t }))
    }

    return next(e)
  })

  // A skill call loads instructions at once; the caller then works under it
  // until its turn ends, so it stays 'active' until then.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    let id = ''
    try {
      const t = await $.clock.now()
      const by = e.agentId
      const stepSource = by
        ? (await read($, agents)).find(a => a.id === by)?.step
        : (await read($, plan)).find(st => st.status === 'in_progress')?.content
      const name = e.skill
      await update($, skills, list => {
        const same = list.find(k => k.name === name && k.by === by && k.step === stepSource)
        if (same) {
          id = same.id
          return list.map(k => (k === same ? { ...k, count: k.count + 1, status: 'active' as const, calledAt: t } : k))
        }
        id = e.tool_use_id
        const fresh: TrackedSkill = {
          id,
          name,
          ...(e.args ? { args: oneLine(e.args, 200) } : {}),
          ...(by ? { by } : {}),
          ...(stepSource ? { step: stepSource } : {}),
          calledAt: t,
          status: 'active',
          count: 1,
        }
        return [...list, fresh].slice(-SKILLS_MAX)
      })
    } catch {
      // the pane misses this call; the skill itself goes on
    }
    const ran = await next(e)
    const ok = !('deny' in ran && ran.deny) && (ran.result as { success?: boolean } | undefined)?.success !== false
    if (!ok && id) {
      try {
        await update($, skills, list => list.map(k => (k.id === id ? { ...k, status: 'failed' as const } : k)))
      } catch {
        // best-effort
      }
    }
    return ran
  })

  // A Bash call that runs Codex or Gemini gets a card at once; its log fills it in.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const vendor = vendorOf(e.command)
    if (!vendor) return next(e)
    const id = `ext:${e.tool_use_id}`
    try {
      const t = await $.clock.now()
      const by = e.agentId
      const step = by
        ? (await read($, agents)).find(a => a.id === by)?.step
        : (await read($, plan)).find(st => st.status === 'in_progress')?.content
      const run: ExternalRun = {
        id,
        vendor,
        cwd: runDir(e.command, await $.session.cwd(), (await $.env.get('HOME')) ?? ''),
        startedAt: t,
        isBackground: e.run_in_background === true,
      }
      const card: TrackedAgent = {
        id,
        description: oneLine(e.description || e.command, 120),
        type: VENDOR_NAME[vendor],
        prompt: oneLine(e.command, 300),
        status: 'running',
        startedAt: t,
        toolCalls: 0,
        vendor,
        ...(step ? { step } : {}),
        ...(by ? { parentId: by } : {}),
      }
      await update($, runs, list => [...list.filter(r => r.id !== id), run].slice(-RUNS_MAX))
      await update($, agents, list => [...list.filter(a => a.id !== id), card].slice(-100))
      await update($, now, () => t)
    } catch {
      // the pane misses this run; the command itself goes on
    }
    const ran = await next(e)
    try {
      const result = ('result' in ran ? ran.result : undefined) as
        | { backgroundTaskId?: string; interrupted?: boolean }
        | undefined
      const denied = 'deny' in ran && !!ran.deny
      if (result?.backgroundTaskId && !denied) {
        await update($, runs, list => list.map(r => (r.id === id ? { ...r, isBackground: true } : r)))
      } else {
        const t = await $.clock.now()
        const ok = !denied && !result?.interrupted
        await update($, runs, list => list.map(r => (r.id === id ? { ...r, returnedAt: t, returnedOk: ok } : r)))
        await patch($, id, a => ({ ...a, status: ok ? 'completed' : 'failed', endedAt: t }))
        // one last read of its log, for the final token count
        lastRunsRead = 0
      }
    } catch {
      // best-effort
    }
    return ran
  })

  // A permission dialog shown to the person (auto mode raises none for the
  // calls it settles itself), or a form an MCP server puts to them.
  on('classic.PermissionRequest', async ($, e, next) => {
    await markWaiting($)
    return next(e)
  })
  on('classic.Elicitation', async ($, e, next) => {
    await markWaiting($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (QUESTION_TOOLS.includes(e.tool)) await markWaiting($)
    if (!e.agentId && (e.tool === PLAN_TOOL || e.tool === WRAP_TOOL)) {
      const args = e as unknown as Record<string, unknown>
      try {
        // A new list replaces the plan: keep the old one to look back at.
        if (e.tool === PLAN_TOOL && Array.isArray(args.items)) {
          const old = await read($, plan)
          if (old.length > 0) {
            const archived: ArchivedPlan = { steps: old, endedAt: await $.clock.now() }
            await update($, history, list => [...list, archived].slice(-HISTORY_MAX))
          }
          // a new list is a new plan: what finished before it folds away
          const t = await $.clock.now()
          await update($, turnAt, () => t)
        }
        const stampAt = await $.clock.now()
        await update($, plan, steps =>
          stampTimes(
            steps,
            e.tool === WRAP_TOOL
              ? // Wrapping up checks off the whole list, as the app's own list does.
                steps.map((s): PlanStep => ({ ...s, status: 'completed' }))
              : applyPlanCall(steps, args),
            stampAt,
          ),
        )
      } catch {
        // the pane misses this change; the call itself goes on
      }
    }
    if (e.agentId) {
      const id = e.agentId
      try {
        // The engine's own hand-back at a subagent's end is not the agent's work.
        if (!INTERNAL_TOOLS.includes(e.tool)) {
          const t = await $.clock.now()
          await patch($, id, a => ({
            ...a,
            activeAt: t,
            busy: (a.busy ?? 0) + 1,
            toolCalls: a.toolCalls + 1,
            lastTool: e.tool,
            tools: { ...(a.tools ?? {}), [e.tool]: ((a.tools ?? {})[e.tool] ?? 0) + 1 },
          }))
        }
      } catch {
        // counting is best-effort; the tool call goes on
      }
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      if (e.agentId && !INTERNAL_TOOLS.includes(e.tool)) {
        const t = await $.clock.now().catch(() => 0)
        await patch($, e.agentId, a => ({ ...a, busy: Math.max(0, (a.busy ?? 1) - 1), ...(t ? { activeAt: t } : {}) }))
      }
    }
    try {
      // answered (or refused): nothing waits any more, unless the turn ended on
      // a question for the person, which waits for their message
      const args = e as unknown as Record<string, unknown>
      const t = await $.clock.now()
      if (!e.agentId && e.tool === WRAP_TOOL && args.blocked === true) await update($, waitingAt, cur => cur || t)
      else if ((await read($, waitingAt)) > 0) await update($, waitingAt, () => 0)
    } catch {
      // best-effort
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await read($, now)
    const f = await read($, fold)
    const mine = await snapshotOf($, t)
    mine.agents = await read($, agents)
    mine.history = await read($, history)
    const rest = await read($, others)
    const mode = await read($, view)
    const show: Show = await read($, shownAtom)
    const usage = await read($, stats)
    const prefs = await read($, settings)
    const tokensOf = (n?: number) => (prefs.tokens && n ? w.tokens(n) : '')
    // The graph is an SVG, which the desktop and mobile apps draw; elsewhere, the list.
    const canGraph = e.surface === 'desktop' || e.surface === 'mobile'
    // The view toggle: one segmented control, the shown view filled with a
    // neutral grey (orange stays for "running now"); the other dim, lit on hover.
    const segment = (value: 'list' | 'graph', label: string) => {
      const active = mode === value
      return (
        <Box key={`seg-${value}`} paddingX={1} backgroundColor={active ? 'promptBorder' : undefined}>
          <Button
            key={`btn-view-${value}`}
            plain
            dimColor={!active}
            hover={{ color: 'text' }}
            onPress={() => {
              if (!active) void update($, view, () => value)
            }}
          >
            <Text size="footnote">{label}</Text>
          </Button>
        </Box>
      )
    }
    // Filters and settings are checkboxes. A Button holds text alone (no
    // image), so the box is a glyph, a size smaller than its label.
    const checkRow = (key: string, isOn: boolean, label: string, onPress: () => void) => (
      <Button key={key} plain dimColor={!isOn} hover={{ color: 'text' }} onPress={onPress}>
        <Text size="footnote">
          <Text size="caption">{isOn ? '☑' : '☐'}</Text> {label}
        </Text>
      </Button>
    )
    // Filters: several may be on, so checkboxes, not segments.
    const filter = (key: keyof Show, label: string) =>
      checkRow(`btn-show-${key}`, show[key], label, () => void update($, shownAtom, cur => ({ ...cur, [key]: !cur[key] })))
    const allHidden = !show.plans && !show.agents && !show.skills

    // The ⚙ card: what the pane shows, then the options. The open gear says
    // what the card is, so it carries no title of its own.
    const settingsOpen = isOpen(f, 'settings', false)
    const settingsCard = settingsOpen ? (
      <Box key="settings-card" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text size="caption" color="subtle">
          {w.show}
        </Text>
        <Box flexDirection="row" gap={2} alignItems="center">
          {filter('plans', w.plans)}
          {filter('agents', w.agents)}
          {filter('skills', w.skills)}
        </Box>
        {allHidden && (
          <Text size="caption" color="subtle">
            {w.allHidden}
          </Text>
        )}
        <Box marginTop={1}>
          <Text size="caption" color="subtle">
            {w.options}
          </Text>
        </Box>
        {checkRow('btn-set-tokens', prefs.tokens, w.showTokens, () => void update($, settings, cur => ({ ...cur, tokens: !cur.tokens })))}
        {checkRow('btn-set-notify', prefs.notify !== false, w.notifyWhenWaiting, () =>
          void update($, settings, cur => ({ ...cur, notify: cur.notify === false })),
        )}
        {checkRow('btn-set-autoopen', prefs.autoOpen !== false, w.openAtStart, () =>
          void update($, settings, cur => ({ ...cur, autoOpen: cur.autoOpen === false })),
        )}
        {checkRow('btn-set-openbutton', prefs.openButton !== false, w.openButtonOption, () =>
          void update($, settings, cur => ({ ...cur, openButton: cur.openButton === false })),
        )}
      </Box>
    ) : null
    // The context label, warning-coloured once the window is nearly full.
    const contextLabel = (snap: SessionSnapshot) => {
      if (!prefs.tokens || !snap.contextTokens) return null
      const warning = contextWarning(snap.contextTokens, snap.contextPercent, snap.compactAt, w)
      return (
        <Text size="caption" color={warning ? 'warning' : 'subtle'}>
          {w.inContext(snap.contextTokens)}
          {warning ? ` · ${warning}` : ''}
        </Text>
      )
    }
    const sessionCount = 1 + rest.length
    const liveAll =
      mine.agents.filter(isLive).length + rest.reduce((n, s) => n + s.agents.filter(isLive).length, 0)
    const switchRow = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingX={1}>
        <Text size="caption" color="subtle" wrap="truncate-end">
          {w.sessions(sessionCount)}
          {liveAll > 0 && <Text color="claude"> · ◐ {liveAll}</Text>}
        </Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          {/* the gear in a cell like the List/Graph control's, filled while open */}
          <Box
            key="settings-button"
            borderStyle="round"
            borderColor="promptBorder"
            paddingX={1}
            backgroundColor={settingsOpen ? 'promptBorder' : undefined}
          >
            <Button
              key="btn-settings"
              plain
              dimColor={!settingsOpen}
              hover={{ color: 'text' }}
              onPress={() => void update($, fold, cur => setOpen(cur, 'settings', !settingsOpen))}
            >
              <Text size="footnote">⚙</Text>
            </Button>
          </Box>
          {canGraph && (
            <Box flexDirection="row" borderStyle="round" borderColor="promptBorder">
              {segment('list', w.list)}
              {segment('graph', w.graph)}
            </Box>
          )}
        </Box>
      </Box>
    )

    const toggle = (key: string, open: boolean) => () => {
      void update($, fold, cur => setOpen(cur, key, open))
    }
    // One fold control everywhere: a quiet line, the triangle on the left.
    const foldRow = (key: string, open: boolean, label: string) => (
      <Button key={`btn-${key}`} plain onPress={toggle(key, !open)}>
        <Text size="footnote" color="subtle">
          {open ? '▾' : '▸'} {label}
        </Text>
      </Button>
    )
    const sectionLabel = (label: string) => (
      <Text size="footnote" color="subtle">
        {label}
      </Text>
    )
    const iconCell = (glyph: string, color: string, dim = false) => (
      <Box width={2} flexShrink={0}>
        <Text color={color} dimColor={dim}>
          {glyph}
        </Text>
      </Box>
    )

    // Usage statistics, over all time: a quiet button pinned to the pane's
    // bottom-right (a spacer pushes it there when content is short); open, a
    // card grows above it with the two rankings as bar pictures.
    const statsOpen = isOpen(f, 'stats', false)
    const statsCard = (Svg: ((p: { source: string; width: number; height: number; alt: string; key?: string }) => unknown) | null) => {
      const cardPx = Math.max(10, (e.props.bodyColumns || 50) - 6) * 9
      const ranking = (key: string, title: (n: number) => string, counts: Record<string, number>) => {
        const all = Object.entries(counts).sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
        const total = all.reduce((n, [, c]) => n + c, 0)
        const moreKey = `stats-more:${key}`
        const moreOpen = isOpen(f, moreKey, false)
        const rows = moreOpen ? all : all.slice(0, 5)
        const max = all[0]?.[1] ?? 1
        return (
          <Box key={`rank-${key}`} flexDirection="column">
            <Text size="footnote" weight="medium">
              {title(total)}
            </Text>
            {all.length === 0 ? (
              <Text size="caption" color="subtle">
                {w.noCallsYet}
              </Text>
            ) : Svg ? (
              (() => {
                const pic = rankingPicture(rows, max, cardPx)
                return Svg({ key: `rank-svg-${key}`, source: pic.svg, width: pic.width, height: pic.height, alt: title(total) }) as never
              })()
            ) : (
              rows.map(([name, n]) => (
                <Box key={`rank-${key}-${name}`} flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end">{name}</Text>
                  <Text color="subtle">{groupDigits(n)}</Text>
                </Box>
              ))
            )}
            {all.length > 5 && foldRow(moreKey, moreOpen, moreOpen ? w.fold : w.more(all.length - 5))}
          </Box>
        )
      }
      const empty = Object.keys(usage.skills).length === 0 && Object.keys(usage.agents).length === 0
      return (
        <Box key="stats-card" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={1}>
          <Text size="caption" color="subtle">
            {w.allTime(usage.sessions)}
          </Text>
          {empty ? (
            <Text size="caption" color="subtle">
              {w.noDataYet}
            </Text>
          ) : (
            [
              ranking('skills', w.skillCalls, usage.skills),
              ranking('agents', w.agentRuns, usage.agents),
            ]
          )}
        </Box>
      )
    }
    const statsBlock = (Svg: Parameters<typeof statsCard>[0] = null) => [
      <Box key="stats-spacer" flexGrow={1} />,
      statsOpen ? statsCard(Svg) : null,
      <Box key="stats-button" flexDirection="row" justifyContent="flex-end" paddingX={1}>
        <Button key="btn-stats" plain dimColor hover={{ color: 'text' }} onPress={toggle('stats', !statsOpen)}>
          <Text size="footnote">{`${w.statistics} ${statsOpen ? '▾' : '▴'}`}</Text>
        </Button>
      </Box>,
    ]
    // The pane's full height, so the spacer can push the button to the bottom.
    const fullHeight = e.props.scroll?.bodyRows ?? undefined

    // In a replaced plan an unfinished step was dropped: a dash, struck through.
    const stepRow = (st: PlanStep, key: string, isPast = false) =>
      isPast && st.status !== 'completed' ? (
        <Box key={key} flexDirection="row">
          {iconCell('–', 'subtle')}
          <Text color="inactive" strikethrough wrap="wrap">
            {st.content}
          </Text>
        </Box>
      ) : (
        <Box key={key} flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" flexShrink={1}>
            {iconCell(STEP_ICON[st.status], STEP_COLOR[st.status], st.status === 'completed')}
            <Text
              color={st.status === 'in_progress' ? 'text' : 'inactive'}
              weight={st.status === 'in_progress' ? 'medium' : 'regular'}
              wrap="wrap"
            >
              {st.content}
            </Text>
          </Box>
          {!!stepTime(st, t) && (
            <Text size="caption" color="subtle">
              {stepTime(st, t)}
            </Text>
          )}
        </Box>
      )
    const steps = (list: PlanStep[], keyBase: string, isPast = false) => (
      <Box flexDirection="column">{list.map((st, i) => stepRow(st, `${keyBase}-${i}`, isPast))}</Box>
    )
    const pastLabel = (list: PlanStep[]) => {
      const { done, total } = progress(list)
      return `${done}/${total} · ${oneLine(list[0]?.content ?? '', 40)}${done < total ? ` · ${w.replaced}` : ''}`
    }
    const progress = (list: PlanStep[]) => {
      const done = list.filter(st => st.status === 'completed').length
      return { done, total: list.length, isAllDone: list.length > 0 && done === list.length }
    }

    // This session's own subagent opens its conversation in the main view when pressed.
    const openAgent = (id: string) => () => {
      void $.ui
        .view({ agentId: id })
        .then(shown => {
          if (shown.deny) $.ui.toast(shown.deny)
        })
        .catch(() => {})
    }
    const agentRow = (a: TrackedAgent, depth = 0, isOwn = false): unknown => {
      const stalled = isStalled(a, t)
      const name = (
        <Text weight="medium" color={isLive(a) ? 'text' : 'inactive'} wrap="truncate-end">
          {a.description || w.noDescription}
        </Text>
      )
      return (
      <Box key={a.id} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" flexShrink={1}>
            {iconCell(stalled ? '⚠' : AGENT_ICON[a.status], stalled ? 'warning' : COLOR[a.status], a.status === 'completed')}
            {isOwn && !a.vendor ? (
              <Button key={`btn-open-${a.id}`} plain hover={{ color: 'claude' }} onPress={openAgent(a.id)}>
                {name}
              </Button>
            ) : (
              name
            )}
          </Box>
          <Text size="caption" color={stalled ? 'warning' : 'subtle'}>
            {stalled ? w.quietFor(clockTime(quietMs(a, t))) : clockTime((a.endedAt ?? Math.max(t, a.startedAt)) - a.startedAt)}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text size="caption" color="subtle" wrap="truncate-end">
            {[a.type, a.vendor ? '' : w.calls(a.toolCalls), tokensOf(a.tokens), isLive(a) && a.lastTool ? a.lastTool : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
        {show.skills && (agentSkillsOf.get(a.id) ?? []).length > 0 && (
          <Box paddingLeft={2} flexDirection="row" gap={1}>
            {(agentSkillsOf.get(a.id) ?? []).map(k => (
              <Text key={`ask-${a.id}-${k.id}`} size="caption" color={SKILL_COLOR[k.status]} wrap="truncate-end">
                {SKILL_ICON[k.status]} {shortSkill(k.name)}
                {k.count > 1 ? ` ×${k.count}` : ''}
              </Text>
            ))}
          </Box>
        )}
        {depth < 3 && (childrenOf.get(a.id) ?? []).length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {(childrenOf.get(a.id) ?? []).map(c => agentRow(c, depth + 1, isOwn) as never)}
          </Box>
        )}
      </Box>
      )
    }
    let agentSkillsOf = new Map<string, TrackedSkill[]>()
    let childrenOf = new Map<string, TrackedAgent[]>()
    const withSkillsOf = (snap: SessionSnapshot) => {
      agentSkillsOf = new Map()
      for (const k of snap.skills ?? []) if (k.by) agentSkillsOf.set(k.by, [...(agentSkillsOf.get(k.by) ?? []), k])
      childrenOf = new Map()
      const ids = new Set(snap.agents.map(a => a.id))
      for (const a of snap.agents) {
        if (a.parentId && ids.has(a.parentId)) childrenOf.set(a.parentId, [...(childrenOf.get(a.parentId) ?? []), a])
      }
    }
    const topLevel = (snap: SessionSnapshot) => {
      const ids = new Set(snap.agents.map(a => a.id))
      return snap.agents.filter(a => !a.parentId || !ids.has(a.parentId))
    }

    // The main conversation's skills: active and failed ones listed, used ones folded.
    const skillsPart = (snap: SessionSnapshot) => {
      const main = (snap.skills ?? []).filter(k => !k.by)
      if (!show.skills || main.length === 0) return null
      const lit = main.filter(k => k.status !== 'used').reverse()
      const used = main.filter(k => k.status === 'used').reverse()
      const key = `usedskills:${snap.sessionId}`
      const open = isOpen(f, key, false)
      const skillRow = (k: TrackedSkill) => (
        <Box key={`sk-${k.id}`} flexDirection="row" justifyContent="space-between" gap={1} paddingLeft={2}>
          <Box flexDirection="row" flexShrink={1}>
            {iconCell(SKILL_ICON[k.status], SKILL_COLOR[k.status])}
            <Text weight="medium" color={k.status === 'used' ? 'inactive' : 'text'} wrap="truncate-end">
              {shortSkill(k.name)}
              {k.args ? <Text color="subtle"> · {k.args}</Text> : null}
            </Text>
          </Box>
          {k.count > 1 && (
            <Text size="caption" color="subtle">
              ×{k.count}
            </Text>
          )}
        </Box>
      )
      return (
        <Box key={`skills-${snap.sessionId}`} flexDirection="column">
          {lit.length > 0 && sectionLabel(w.skillsCount(lit.length))}
          {lit.map(skillRow)}
          {used.length > 0 && foldRow(key, open, w.usedSkills(used.length))}
          {open && used.map(skillRow)}
        </Box>
      )
    }

    const agentsPart = (snap: SessionSnapshot, withLabel: boolean) => {
      if (!show.agents) return null
      withSkillsOf(snap)
      const live = topLevel(snap).filter(isLive).reverse()
      const done = topLevel(snap).filter(a => !isLive(a)).reverse()
      const doneKey = `done:${snap.sessionId}`
      const doneOpen = isOpen(f, doneKey, false)
      if (live.length === 0 && done.length === 0) return null
      return (
        <Box key={`agents-${snap.sessionId}`} flexDirection="column">
          {withLabel && live.length > 0 && sectionLabel(w.subagentsCount(live.length))}
          {live.length > 0 && (
            <Box flexDirection="column" paddingLeft={withLabel ? 2 : 0}>
              {live.map(a => agentRow(a, 0, withLabel) as never)}
            </Box>
          )}
          {done.length > 0 && foldRow(doneKey, doneOpen, w.finishedSubagents(done.length))}
          {doneOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {done.slice(0, 10).map(a => agentRow(a, 0, withLabel) as never)}
            </Box>
          )}
        </Box>
      )
    }

    const historyPart = (snap: SessionSnapshot) => {
      if (!show.plans) return null
      const past = [...(snap.history ?? [])].reverse()
      if (past.length === 0) return null
      const key = `history:${snap.sessionId}`
      const open = isOpen(f, key, false)
      return (
        <Box key={`hist-${snap.sessionId}`} flexDirection="column">
          {foldRow(key, open, w.pastPlans(past.length))}
          {open && (
            <Box flexDirection="column" paddingLeft={2}>
              {past.map((p, n) => {
                const pKey = `past:${snap.sessionId}:${p.endedAt}`
                const pOpen = isOpen(f, pKey, false)
                return (
                  <Box key={`past-${snap.sessionId}-${n}`} flexDirection="column">
                    {foldRow(pKey, pOpen, pastLabel(p.steps))}
                    {pOpen && (
                      <Box paddingLeft={2} flexDirection="column">
                        {steps(p.steps, `pst-${snap.sessionId}-${n}`, true)}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    const nameOf = nameOfSession
    const stateOf = (snap: SessionSnapshot) => stateOfSession(snap, t)

    // Another session's header: the fold triangle, its name, its plan's count;
    // folded, its current step and how many agents run under it.
    const otherHeader = (snap: SessionSnapshot, key: string, open: boolean) => {
      const live = snap.agents.filter(isLive).length
      const stepNow = snap.plan.find(st => st.status === 'in_progress')
      const { done, total, isAllDone } = progress(snap.plan)
      return (
        <Box key={`head-${snap.sessionId}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="row" gap={1} flexShrink={1}>
              <Button key={`btn-${key}`} plain onPress={toggle(key, !open)}>
                <Text color="subtle">{open ? '▾' : '▸'}</Text>
              </Button>
              <Text weight="semibold" bold wrap="truncate-end">
                {nameOf(snap)}
              </Text>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {stateOf(snap) === 'waiting' && (
                <Text size="caption" color="warning">
                  {w.waitingForYou}
                </Text>
              )}
              {contextLabel(snap)}
              {show.plans && total > 0 && (
                <Text size="caption" color={isAllDone ? 'success' : 'subtle'}>
                  {done}/{total}
                </Text>
              )}
            </Box>
          </Box>
          {!open && ((show.plans && stepNow) || live > 0) && (
            <Box flexDirection="column" paddingLeft={2}>
              {show.plans && stepNow && stepRow(stepNow, `now-${snap.sessionId}`)}
              {live > 0 && (
                <Box flexDirection="row">
                  {iconCell('◐', 'claude')}
                  <Text size="footnote" color="subtle">
                    {w.runningAgents(live)}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }
    const anyOtherOpen = rest.some(s => isOpen(f, `session:${s.sessionId}`, true))
    const setAllOthers = (open: boolean) => () => {
      void update($, fold, cur =>
        rest.reduce((acc, s) => setOpen(acc, `session:${s.sessionId}`, open), cur),
      )
    }
    const othersHeading =
      rest.length > 0 ? (
        <Box key="others-heading" flexDirection="row" justifyContent="space-between" gap={1} paddingX={1} marginTop={1}>
          {sectionLabel(w.otherSessions(rest.length))}
          <Button key="btn-all" plain dimColor hover={{ color: 'text' }} onPress={setAllOthers(!anyOtherOpen)}>
            <Text size="footnote" color="subtle">
              {anyOtherOpen ? w.foldAll : w.unfoldAll}
            </Text>
          </Button>
        </Box>
      ) : null

    if (canGraph && mode === 'graph' && (e.surface === 'desktop' || e.surface === 'mobile')) {
      const { Svg } = $.ui.resolve(e)
      // The pane gives its width in columns; ~9px each on the desktop. Two of
      // them go to the fold triangle's column, which the body's indent matches.
      const px = Math.max(2, (e.props.bodyColumns || 50) - 2) * 9
      // Drawn as an image under a stable key: a new source swaps in place, with
      // no frame reloading (and no flash). SMIL still runs in an image.
      const picture = (pic: Picture, alt: string, at: string) => (
        <Svg key={`pic-${at}`} source={pic.svg} width={pic.width} height={pic.height} alt={alt} />
      )
      // Every session alike: [▾][name frame], and under it, indented by the
      // triangle's column, what hangs off the frame by lines. Folding hides that.
      const sessionGraph = (snap: SessionSnapshot, isOwn: boolean) => {
        const sKey = `session:${snap.sessionId}`
        const sOpen = isOpen(f, sKey, true)
        const liveHere = snap.agents.filter(isLive).length
        const past = assignAgents(snap).past
        const history = show.plans ? snap.history ?? [] : []
        const body = bodyPicture(snap, t, px, show, w, prefs.tokens)
        const hKey = `history:${snap.sessionId}`
        const hOpen = isOpen(f, hKey, false)
        const pastAgents = past.reduce((n, list) => n + list.length, 0)
        const earlier = show.agents ? splitLoose(snap).earlier : []
        const eKey = `earlier:${snap.sessionId}`
        const eOpen = isOpen(f, eKey, false)
        return (
          <Box key={`gs-${snap.sessionId}`} flexDirection="column">
            {isOwn && (
              <Box paddingLeft={2}>
                <Text size="caption" color="claude">
                  ● {w.thisSession}
                </Text>
              </Box>
            )}
            <Box flexDirection="row" alignItems="center">
              <Box width={2} alignItems="center" flexShrink={0}>
                <Button key={`btn-${sKey}`} plain dimColor hover={{ color: 'text' }} onPress={toggle(sKey, !sOpen)}>
                  <Text>{sOpen ? '▾' : '▸'}</Text>
                </Button>
              </Box>
              {picture(
                headerPicture(nameOf(snap), snap.plan, isOwn, sOpen && !body.isEmpty, liveHere, px, show, w, prefs.tokens ? snap.contextTokens : undefined, stateOf(snap), t, snap.contextPercent, snap.compactAt),
                nameOf(snap),
                `head-${snap.sessionId}`,
              )}
            </Box>
            {sOpen && (
              <Box flexDirection="column" paddingLeft={2}>
                {!body.isEmpty &&
                  picture(
                    body,
                    w.sessionAlt(nameOf(snap), snap.plan.length, snap.agents.length),
                    `body-${snap.sessionId}`,
                  )}
                {earlier.length > 0 && foldRow(eKey, eOpen, w.finishedSubagents(earlier.length))}
                {eOpen &&
                  earlier.length > 0 &&
                  picture(
                    earlierPicture(snap, t, px - 18, w, prefs.tokens),
                    w.finishedSubagents(earlier.length),
                    `earlier-${snap.sessionId}`,
                  )}
                {history.length > 0 &&
                  foldRow(
                    hKey,
                    hOpen,
                    w.pastPlansWithAgents(history.length, pastAgents),
                  )}
                {hOpen &&
                  history
                    .map((past1, n) => ({ past1, n }))
                    .reverse()
                    .map(({ past1, n }) => {
                      // Each past plan folds on its own (shared with the list view).
                      const pKey = `past:${snap.sessionId}:${past1.endedAt}`
                      const pOpen = isOpen(f, pKey, false)
                      return (
                        <Box key={`gp-${snap.sessionId}-${past1.endedAt}`} flexDirection="column" paddingLeft={2}>
                          {foldRow(pKey, pOpen, pastLabel(past1.steps))}
                          {pOpen &&
                            picture(
                              planPicture(snap, n, t, px - 18, show, w, prefs.tokens),
                              w.pastPlanAlt(past1.steps.length),
                              `${snap.sessionId}-${past1.endedAt}`,
                            )}
                        </Box>
                      )
                    })}
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1} minHeight={fullHeight}>
          {switchRow}
          {settingsCard}
          {sessionGraph(mine, true)}
          {othersHeading}
          {rest.map(snap => sessionGraph(snap, false))}
          {statsBlock(Svg as never)}
        </Box>
      )
    }

    // ---- this session: the one frame of the pane ----
    const ownPlan = () => {
      if (!show.plans || mine.plan.length === 0) return null
      const { done, total, isAllDone } = progress(mine.plan)
      const key = `plan:${mine.sessionId}`
      const open = isOpen(f, key, !isAllDone)
      return (
        <Box key="own-plan" flexDirection="column">
          {foldRow(key, open, w.planCount(done, total))}
          {open && <Box paddingLeft={2}>{steps(mine.plan, 'own-step')}</Box>}
        </Box>
      )
    }
    const ownParts = [ownPlan(), agentsPart(mine, true), skillsPart(mine), historyPart(mine)].filter(Boolean)
    const ownBlock = (
      <Box
        key="own"
        flexDirection="column"
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
        gap={1}
      >
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold" bold wrap="truncate-end">
            <Text color="claude">● </Text>
            {nameOf(mine)}
          </Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {stateOf(mine) === 'waiting' && (
              <Text size="caption" color="warning">
                {w.waitingForYou}
              </Text>
            )}
            {contextLabel(mine)}
            <Text size="caption" color="subtle">
              {w.thisSession}
            </Text>
          </Box>
        </Box>
        {ownParts.length === 0 ? (
          <Text size="footnote" color="subtle">
            {allHidden ? w.allHiddenDot : w.nothingYet}
          </Text>
        ) : (
          ownParts
        )}
      </Box>
    )

    // ---- other sessions: no frames, a header and an indented body ----
    const otherBlock = (snap: SessionSnapshot) => {
      const key = `session:${snap.sessionId}`
      const open = isOpen(f, key, true)
      return (
        <Box key={`other-${snap.sessionId}`} flexDirection="column" paddingX={1}>
          {otherHeader(snap, key, open)}
          <Box flexDirection="column" paddingLeft={2}>
            {open && show.plans && snap.plan.length > 0 && steps(snap.plan, `step-${snap.sessionId}`)}
            {open && agentsPart(snap, false)}
            {open && skillsPart(snap)}
            {open && historyPart(snap)}
            {open && !allHidden && snap.plan.length === 0 && snap.agents.length === 0 && (snap.skills ?? []).length === 0 && (
              <Text size="footnote" color="subtle">
                {w.nothingYet}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const listSvg = canGraph && (e.surface === 'desktop' || e.surface === 'mobile') ? $.ui.resolve(e).Svg : null
    return (
      <Box flexDirection="column" gap={1} minHeight={fullHeight}>
        {switchRow}
        {settingsCard}
        {ownBlock}
        {othersHeading}
        {rest.map(otherBlock)}
        {statsBlock(listSvg as never)}
      </Box>
    )
  })
}
