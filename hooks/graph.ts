import type { AgentStatusWord, PlanStep, SessionSnapshot, TrackedAgent, TrackedSkill } from '../types'
import { WORDS } from './i18n'
import type { Words } from './i18n'

// The graph pictures. Every session is two: a header (its name frame) and a
// body that hangs off it — the plan as a trunk of steps, each subagent as a
// card to the right of the step it was spawned under, each skill the main
// conversation called as a pill under its step, and a subagent's own skills as
// chips on its card. With plans hidden the trunk is a time axis. Running parts
// pulse and their edges flow (SMIL runs in an image too).

const PAD = 12
const TRUNK = PAD + 14
const TEXT_X = TRUNK + 14
const STEP_LINE = 15
const AGENT_H = 60
const AGENT_GAP = 8
const TIMELINE_ROW = 70
const PILL_H = 22
const PILL_ROW = 28
const DONE_SHOWN = 6
const CHAR = 6.6 // px per character of 12px text, a fair Cyrillic/Latin average

// The engine's own hand-back at a subagent's end, not the agent's work.
const INTERNAL = ['SubagentHandback']

export type Show = { plans: boolean; agents: boolean; skills: boolean }
export const SHOW_ALL: Show = { plans: true, agents: true, skills: true }

const LIVE: AgentStatusWord[] = ['pending', 'running', 'waiting', 'idle']
const isLive = (a: TrackedAgent) => LIVE.includes(a.status)

// A running subagent with no tool call in flight and none for this long may be stuck.
export const STALL_MS = 3 * 60_000
export const isStalled = (a: TrackedAgent, now: number) =>
  a.status === 'running' && !a.vendor && (a.busy ?? 0) === 0 && now - (a.activeAt ?? a.startedAt) > STALL_MS
export const quietMs = (a: TrackedAgent, now: number) => now - (a.activeAt ?? a.startedAt)

// How long a step took, or has taken so far; '' when its start was not seen.
export const stepTime = (st: PlanStep, now: number) =>
  !st.startedAt || st.status === 'pending' || (st.status === 'completed' && !st.endedAt)
    ? ''
    : clockTime((st.status === 'completed' ? st.endedAt! : Math.max(now, st.startedAt)) - st.startedAt)

// The context is nearly full from here on.
export const CONTEXT_WARN_PERCENT = 80

const STATUS_CLASS: Record<AgentStatusWord, string> = {
  pending: 'idle',
  running: 'run',
  waiting: 'wait',
  idle: 'idle',
  completed: 'ok',
  failed: 'bad',
  killed: 'off',
}
const STATUS_GLYPH: Record<AgentStatusWord, string> = {
  pending: '◌',
  running: '◐',
  waiting: '◔',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '⊘',
}
const STEP_CLASS: Record<PlanStep['status'], string> = {
  pending: 'idle',
  in_progress: 'run',
  completed: 'ok',
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const cut = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)) + '…' : flat
}

// At most `lines` lines of `max` characters, by words; the last one cut.
const wrap = (s: string, max: number, lines: number): string[] => {
  const words = s.replace(/\s+/g, ' ').trim().split(' ')
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < words.length && out.length < lines - 1) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!
    if (next.length <= max || !cur) {
      cur = next
      i++
    } else {
      out.push(cur)
      cur = ''
    }
  }
  const rest = [cur, ...words.slice(i)].filter(Boolean).join(' ')
  if (rest) out.push(cut(rest, max))
  return out.length ? out : ['']
}

const clockTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const shortTool = (name: string) => name.replace(/^mcp__.*__/, '')
/** `anthropic-skills:docx` → `docx`. */
export const shortSkill = (name: string) => name.split(':').pop() ?? name

const edge = (x1: number, y1: number, x2: number, y2: number, live: boolean) => {
  const mid = (x1 + x2) / 2
  const d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`
  return live
    ? `<path d="${d}" class="edge live"><animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.9s" repeatCount="indefinite"/></path>`
    : `<path d="${d}" class="edge"/>`
}

const diamond = (cx: number, cy: number, r: number, cls: string) =>
  `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" class="dia ${cls}"/>`

const skillTip = (k: TrackedSkill, w: Words) =>
  `${k.name}${k.count > 1 ? ` ×${k.count}` : ''} · ${w.skillStatus[k.status]}${k.args ? `\n${k.args}` : ''}`

// ---- skill pills -------------------------------------------------------------

const pillLabel = (k: TrackedSkill) => `${shortSkill(k.name)}${k.count > 1 ? ` ×${k.count}` : ''}`
const pillWidth = (k: TrackedSkill) => Math.min(170, Math.round(pillLabel(k).length * 7 + 30))

/** Rows of pills from (x0, y0), wrapping before `maxX`; the height they take. */
const pillRows = (k: TrackedSkill[], x0: number, maxX: number) => {
  const placed: { k: TrackedSkill; x: number; row: number; w: number }[] = []
  let x = x0
  let row = 0
  for (const one of k) {
    const w = Math.min(pillWidth(one), maxX - x0)
    if (x > x0 && x + w > maxX) {
      row++
      x = x0
    }
    placed.push({ k: one, x, row, w })
    x += w + 6
  }
  return { placed, rows: k.length ? row + 1 : 0 }
}

const drawPills = (parts: string[], k: TrackedSkill[], x0: number, y0: number, maxX: number, w: Words) => {
  const { placed, rows } = pillRows(k, x0, maxX)
  for (const p of placed) {
    const y = y0 + p.row * PILL_ROW
    const label = cut(pillLabel(p.k), Math.floor((p.w - 30) / 6.6))
    parts.push(`<g><title>${esc(skillTip(p.k, w))}</title>
      <rect x="${p.x}" y="${y}" width="${p.w}" height="${PILL_H}" rx="11" class="pill ${p.k.status}"/>
      ${diamond(p.x + 11, y + PILL_H / 2, 4.5, p.k.status)}
      <text x="${p.x + 22}" y="${y + 15}" class="pilltext">${esc(label)}</text></g>`)
  }
  return rows * PILL_ROW
}

// A dotted elbow from a trunk point down to the first pill of a row.
const skillLink = (fromY: number, toY: number, toX: number) =>
  `<path d="M${TRUNK},${fromY} V${toY} H${toX}" class="slink"/>`

// ---- agent cards ---------------------------------------------------------------

const agentNode = (
  a: TrackedAgent,
  x: number,
  y: number,
  w: number,
  now: number,
  agentSkills: TrackedSkill[],
  wd: Words,
  withTokens = true,
) => {
  const tok = withTokens && a.tokens ? a.tokens : 0
  // tokens stand at the right of the second line, so a narrow card cuts its kind, not them
  const tokLabel = tok ? wd.tokens(tok) : ''
  const tokW = tok ? Math.round(tokLabel.length * 5.6 + 8) : 0
  // a Codex or Gemini card names its vendor and model in a chip, the line its time alone
  const stalled = isStalled(a, now)
  const cls = stalled ? 'wait' : STATUS_CLASS[a.status]
  const running = a.status === 'running'
  const time = clockTime((a.endedAt ?? Math.max(now, a.startedAt)) - a.startedAt)
  const textChars = Math.floor((w - 34) / CHAR)

  // The busiest tools as chips; the one in use now, on a running agent, first and lit.
  const counts = Object.entries(a.tools ?? {}).sort((p, q) => q[1] - p[1])
  // An agent from before tools were counted one by one: its total alone.
  if (counts.length === 0 && a.toolCalls > 0) {
    const last = a.lastTool && !INTERNAL.includes(a.lastTool) ? a.lastTool : wd.callsChip
    counts.push([last, a.toolCalls])
  }
  if (running && a.lastTool) {
    const at = counts.findIndex(([n]) => n === a.lastTool)
    if (at > 0) counts.unshift(...counts.splice(at, 1))
  }
  // Its skills first, as outlined chips with a diamond; then its tools.
  const chipsIn: { label: string; tip: string; cls: string; skill?: TrackedSkill }[] = [
    ...agentSkills.map(k => ({
      label: `${shortSkill(k.name)}${k.count > 1 ? ` ${k.count}` : ''}`,
      tip: skillTip(k, wd),
      cls: `skill ${k.status}`,
      skill: k,
    })),
    ...counts.map(([name, n]) => ({
      label: `${shortTool(name)} ${n}`,
      tip: `${name}: ${n}`,
      cls: running && !stalled && name === a.lastTool && !INTERNAL.includes(name) ? 'now' : '',
    })),
  ]
  const chips: string[] = []
  let cx = x + 26
  let shown = 0
  for (const c of chipsIn) {
    const cw = Math.round(c.label.length * 5.6 + (c.skill ? 22 : 12))
    if (cx + cw > x + w - 30) break
    chips.push(`<g><title>${esc(c.tip)}</title>
      <rect x="${cx}" y="${y + 39}" width="${cw}" height="15" rx="7.5" class="chip ${c.cls}"/>
      ${c.skill ? diamond(cx + 8, y + 46.5, 3.5, c.skill.status) : ''}
      <text x="${c.skill ? cx + 14 + (cw - 14) / 2 : cx + cw / 2}" y="${y + 50}" class="chiptext mid">${esc(c.label)}</text></g>`)
    cx += cw + 4
    shown++
  }
  if (shown < chipsIn.length) {
    chips.push(`<text x="${cx + 2}" y="${y + 50}" class="tiny">+${chipsIn.length - shown}</text>`)
  }
  if (chipsIn.length === 0 && a.vendor) {
    // a Codex or Gemini card: its CLI's tools are not counted, so its vendor instead
    const label = cut(`${a.vendor === 'codex' ? 'Codex' : 'Gemini'}${a.model ? ` · ${a.model}` : ''}`, Math.floor((w - 40) / 5.6))
    const cw = Math.round(label.length * 5.6 + 12)
    chips.push(`<rect x="${x + 26}" y="${y + 39}" width="${cw}" height="15" rx="7.5" class="chip vendor ${a.vendor}"/>
      <text x="${x + 26 + cw / 2}" y="${y + 50}" class="chiptext mid">${esc(label)}</text>`)
  } else if (chipsIn.length === 0) {
    chips.push(`<text x="${x + 26}" y="${y + 50}" class="tiny">${esc(wd.noTools)}</text>`)
  }

  const tip = [
    a.description || wd.noDescription,
    `${a.type} · ${wd.agentStatus[a.status]} · ${time}${tok ? ` · ${wd.tokens(tok)}` : ''}`,
    stalled ? `${wd.quietFor(clockTime(quietMs(a, now)))}: ${wd.quietTip}` : '',
    a.vendor ? '' : wd.toolCalls(a.toolCalls),
    ...counts.map(([n, c]) => `  ${n}: ${c}`),
    ...agentSkills.map(k => `  ${wd.skillWord} ${skillTip(k, wd)}`),
    a.prompt ? `\n${cut(a.prompt, 300)}` : '',
  ].join('\n')

  return `<g>
    <title>${esc(tip)}</title>
    <rect x="${x}" y="${y}" width="${w}" height="${AGENT_H}" rx="10" class="node ${cls}"/>
    ${
      running
        ? `<circle cx="${x + 13}" cy="${y + 15}" r="7" class="pulse ring"><animate attributeName="r" values="4;9;4" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0.1;0.6" dur="1.4s" repeatCount="indefinite"/></circle><circle cx="${x + 13}" cy="${y + 15}" r="4" class="pulse"/>`
        : `<text x="${x + 8}" y="${y + 20}" class="glyph ${cls}">${STATUS_GLYPH[a.status]}</text>`
    }
    <text x="${x + 26}" y="${y + 19}" class="label strong">${esc(cut(a.description || wd.noDescription, textChars))}</text>
    <text x="${x + 26}" y="${y + 33}" class="tiny${stalled ? ' warntext' : ''}">${esc(cut(stalled ? wd.quietFor(clockTime(quietMs(a, now))) : a.vendor ? time : `${a.type} · ${time}`, Math.floor((w - 34 - tokW) / 5.6)))}</text>
    ${tok ? `<text x="${x + w - 10}" y="${y + 33}" class="tiny end">${esc(tokLabel)}</text>` : ''}
    ${chips.join('\n')}
  </g>`
}

const STYLE = `<style>
  :root { --fg:#1f1f1f; --dim:#7a7a7a; --line:#cfcfcf; --node:#f4f3f0; --chip:#e9e7e2; --accent:#d97757; --ok:#3f9b5a; --bad:#d0463b; --warn:#c99a2e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#ececec; --dim:#9a9a9a; --line:#4a4a4a; --node:#262624; --chip:#34332f; --accent:#d97757; --ok:#5cbf7a; --bad:#e2625a; --warn:#e0b450; }
  }
  svg { display: block; }
  text { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: var(--fg); }
  .head { font-size: 15px; font-weight: 600; } .count { font-size: 13px; fill: var(--dim); }
  .frame { fill: var(--node); stroke: var(--line); stroke-width: 1; } .frame.own { stroke: var(--accent); stroke-width: 1.5; }
  .label { font-size: 12px; } .strong { font-weight: 600; }
  .step { font-size: 12px; fill: var(--dim); } .step.run { fill: var(--fg); font-weight: 600; }
  .tiny { font-size: 10.5px; fill: var(--dim); }
  .chiptext { font-size: 10px; fill: var(--fg); } .pilltext { font-size: 12px; fill: var(--fg); }
  .mid { text-anchor: middle; } .end { text-anchor: end; }
  .glyph { font-size: 13px; }
  .node { fill: var(--node); stroke: var(--line); stroke-width: 1; }
  .node.run { stroke: var(--accent); } .node.ok, .node.off { opacity: 0.78; }
  .node.bad { stroke: var(--bad); } .node.wait { stroke: var(--warn); }
  .chip { fill: var(--chip); stroke: none; } .chip.now { fill: none; stroke: var(--accent); stroke-width: 1.2; }
  .chip.vendor { fill: none; stroke: var(--dim); stroke-width: 1; }
  .chip.skill { fill: none; stroke: var(--dim); stroke-width: 1; stroke-dasharray: 1 2; }
  .chip.skill.active { stroke: var(--accent); } .chip.skill.failed { stroke: var(--bad); }
  .pill { fill: none; stroke: var(--line); stroke-width: 1; } .pill.active { stroke: var(--accent); } .pill.failed { stroke: var(--bad); }
  .dia { fill: none; stroke: var(--dim); stroke-width: 1.2; } .dia.active { fill: var(--accent); stroke: var(--accent); } .dia.failed { stroke: var(--bad); }
  .slink { fill: none; stroke: var(--dim); stroke-width: 1; stroke-dasharray: 1 3; }
  .glint { stroke-width: 2; stroke-linecap: round; }
  .knock { fill: none; stroke: var(--accent); stroke-width: 2.5; }
  .frame.wait { stroke-opacity: 0.35; }
  .tiny.warntext { fill: var(--warn); }
  .glyph.run, .accent { fill: var(--accent); } .glyph.ok, .okfill { fill: var(--ok); } .glyph.bad { fill: var(--bad); }
  .glyph.wait { fill: var(--warn); } .glyph.idle, .glyph.off { fill: var(--dim); }
  .dot { stroke-width: 1.5; } .dot.ok { fill: var(--ok); stroke: var(--ok); }
  .dot.run { fill: var(--accent); stroke: var(--accent); } .dot.idle { fill: var(--node); stroke: var(--dim); }
  .dot.skip { fill: none; stroke: var(--dim); stroke-dasharray: 2 2; } .step.skip { text-decoration: line-through; opacity: 0.7; }
  .pulse { fill: var(--accent); } .ring { opacity: 0.35; }
  .trunk { stroke: var(--line); stroke-width: 1.6; }
  .edge { fill: none; stroke: var(--line); stroke-width: 1.4; }
  .edge.live { stroke: var(--accent); stroke-dasharray: 6 6; }
  .rname { font-size: 13px; } .rpre { opacity: 0.5; }
  .rnum { font-size: 13px; fill: var(--dim); font-variant-numeric: tabular-nums; }
  .rtrack { fill: var(--fg); opacity: 0.06; } .rbar { fill: var(--fg); opacity: 0.35; } .rbar.lead { opacity: 0.55; }
</style>`

const wrapSvg = (W: number, H: number, parts: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
${STYLE}
${parts.join('\n')}
</svg>`

export type Picture = { svg: string; width: number; height: number; key: string; isEmpty?: boolean }

// A short stable digest of what a picture shows.
const digest = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const picture = (W: number, H: number, parts: string[], isEmpty = false): Picture => {
  const svg = wrapSvg(W, H, parts)
  return { svg, width: W, height: H, key: digest(svg.replace(/\d+:\d\d(:\d\d)?/g, '')), isEmpty }
}

// ---- which plan things ran under ---------------------------------------------

/**
 * Splits items over the session's plans: the first plan, oldest first, that
 * was still current at the item's time and holds its step; failing that any
 * plan holding its step; else none (it ran with no plan).
 */
const byPlan = <T>(snap: SessionSnapshot, items: T[], stepOf: (t: T) => string | undefined, timeOf: (t: T) => number) => {
  const plans = [
    ...(snap.history ?? []).map(h => ({ steps: h.steps, endedAt: h.endedAt })),
    { steps: snap.plan, endedAt: Number.POSITIVE_INFINITY },
  ]
  const lists = plans.map(() => [] as T[])
  const loose: T[] = []
  for (const it of items) {
    const step = stepOf(it)
    const has = (p: { steps: PlanStep[] }) => !!step && p.steps.some(st => st.content === step)
    let at = plans.findIndex(p => p.endedAt >= timeOf(it) && has(p))
    if (at < 0) at = plans.findIndex(has)
    if (at < 0) loose.push(it)
    else lists[at]!.push(it)
  }
  return { current: lists[plans.length - 1]!, past: lists.slice(0, -1), loose }
}

/** Agents that hang under no other card of the session (a run's own agents hang under it). */
const topAgents = (snap: SessionSnapshot) => {
  const ids = new Set(snap.agents.map(a => a.id))
  return snap.agents.filter(a => !a.parentId || !ids.has(a.parentId))
}
const childrenMap = (snap: SessionSnapshot) => {
  const ids = new Set(snap.agents.map(a => a.id))
  const map = new Map<string, TrackedAgent[]>()
  for (const a of snap.agents) if (a.parentId && ids.has(a.parentId)) map.set(a.parentId, [...(map.get(a.parentId) ?? []), a])
  return map
}

/**
 * Agents that ran under no plan step: the live ones and those that finished
 * since the latest user message or plan stay above the plan; older finished
 * ones fold away.
 */
export const splitLoose = (snap: SessionSnapshot) => {
  const loose = assignAgents(snap).loose
  const since = snap.turnAt ?? 0
  const isFresh = (a: TrackedAgent) => isLive(a) || (a.endedAt ?? a.startedAt) >= since
  return { fresh: loose.filter(isFresh), earlier: loose.filter(a => !isFresh(a)) }
}

export const assignAgents = (snap: SessionSnapshot) =>
  byPlan(snap, topAgents(snap), a => a.step, a => a.startedAt)

/** The main conversation's skills split over plans; a subagent's go on its card. */
export const assignSkills = (snap: SessionSnapshot) =>
  byPlan(snap, (snap.skills ?? []).filter(k => !k.by), k => k.step, k => k.calledAt)

const skillsOfAgent = (snap: SessionSnapshot) => {
  const map = new Map<string, TrackedSkill[]>()
  for (const k of snap.skills ?? []) if (k.by) map.set(k.by, [...(map.get(k.by) ?? []), k])
  return map
}

// Keeps every live agent and the last few finished ones, in order.
const trim = (agents: TrackedAgent[]) => {
  const done = agents.filter(a => !isLive(a)).slice(-DONE_SHOWN)
  return agents.filter(a => isLive(a) || done.includes(a))
}

type Ctx = {
  W: number
  now: number
  show: Show
  agentSkills: Map<string, TrackedSkill[]>
  w: Words
  tokens: boolean
  children: Map<string, TrackedAgent[]>
}

const CHILD_INDENT = 18
const CHILD_GAP = 6

/** An agent's card and, under it, its own agents' cards, each indented. */
const agentStack = (parts: string[], a: TrackedAgent, x: number, y: number, w: number, ctx: Ctx, depth = 0): number => {
  parts.push(agentNode(a, x, y, w, ctx.now, ctx.show.skills ? ctx.agentSkills.get(a.id) ?? [] : [], ctx.w, ctx.tokens))
  let h = AGENT_H
  const kids = depth < 3 ? trim(ctx.children.get(a.id) ?? []) : []
  for (const k of kids) {
    const ky = y + h + CHILD_GAP
    parts.push(`<path d="M${x + 12},${y + h} V${ky + AGENT_H / 2} H${x + CHILD_INDENT}" class="edge${isLive(k) ? ' live' : ''}"/>`)
    h += CHILD_GAP + agentStack(parts, k, x + CHILD_INDENT, ky, w - CHILD_INDENT, ctx, depth + 1)
  }
  return h
}
const stackHeight = (a: TrackedAgent, ctx: Ctx, depth = 0): number =>
  AGENT_H + (depth < 3 ? trim(ctx.children.get(a.id) ?? []) : []).reduce((n, k) => n + CHILD_GAP + stackHeight(k, ctx, depth + 1), 0)

// A plan as a trunk of steps from `top`: each step's skills as pills under its
// text, its agents as cards to the right.
const drawPlan = (
  parts: string[],
  steps: PlanStep[],
  agents: TrackedAgent[],
  skills: TrackedSkill[],
  y: number,
  top: number,
  ctx: Ctx,
  isPast = false,
) => {
  const { W, now, show } = ctx
  const shown = show.agents ? trim(agents) : []
  const leftW = shown.length > 0 ? Math.round((W - 2 * PAD) * 0.46) : W - 2 * PAD
  const ax = PAD + leftW + 22
  const aw = W - PAD - ax
  const agentsAt = new Map<string, TrackedAgent[]>()
  for (const a of shown) if (a.step) agentsAt.set(a.step, [...(agentsAt.get(a.step) ?? []), a])
  const skillsAt = new Map<string, TrackedSkill[]>()
  if (show.skills) for (const k of skills) if (k.step) skillsAt.set(k.step, [...(skillsAt.get(k.step) ?? []), k])
  const placed = new Set<string>()
  let bottom = top
  const stepChars = Math.floor((leftW - (TEXT_X - PAD)) / CHAR)
  for (const st of steps) {
    const took = isPast && st.status !== 'completed' ? '' : stepTime(st, now)
    const tookW = took ? Math.ceil((took.length * 5.6 + 8) / CHAR) : 0
    const lines = wrap(st.content, stepChars - tookW, 2)
    const textH = lines.length * STEP_LINE + 6
    // A step named twice in one plan gets its agents and skills once.
    const first = !placed.has(st.content)
    placed.add(st.content)
    const mine = first ? agentsAt.get(st.content) ?? [] : []
    const ks = first ? skillsAt.get(st.content) ?? [] : []
    const cy = y + (mine.length ? Math.max(textH, 22) / 2 + 6 : textH / 2)
    const pillY = cy + textH / 2 + 2
    const pillsH = ks.length ? pillRows(ks, TEXT_X, PAD + leftW).rows * PILL_ROW : 0
    const heights = mine.map(a => stackHeight(a, ctx))
    const agentsH = heights.reduce((n, h) => n + h + AGENT_GAP, 0) - (mine.length ? AGENT_GAP : 0)
    const rowH = Math.max(cy - y + textH / 2 + pillsH, agentsH)
    const sc = isPast && st.status !== 'completed' ? 'skip' : STEP_CLASS[st.status]
    const firstY = cy - ((lines.length - 1) * STEP_LINE) / 2 + 4
    parts.push(`<g><title>${esc(sc === 'skip' ? `${st.content}\n${ctx.w.stepDropped}` : `${st.content}${took ? ` · ${took}` : ''}`)}</title>
      ${took ? `<text x="${PAD + leftW - 4}" y="${firstY}" class="tiny end">${esc(took)}</text>` : ''}
      ${sc === 'run' ? `<circle cx="${TRUNK}" cy="${cy}" r="8" class="pulse ring"><animate attributeName="r" values="5;10;5" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.5;0.05;0.5" dur="1.6s" repeatCount="indefinite"/></circle>` : ''}
      <circle cx="${TRUNK}" cy="${cy}" r="5" class="dot ${sc}"/>
      ${lines.map((l, i) => `<text x="${TEXT_X}" y="${cy - ((lines.length - 1) * STEP_LINE) / 2 + 4 + i * STEP_LINE}" class="step ${sc}">${esc(l)}</text>`).join('')}
    </g>`)
    if (ks.length) {
      parts.push(skillLink(cy + 6, pillY + PILL_H / 2, TEXT_X))
      drawPills(parts, ks, TEXT_X, pillY, PAD + leftW, ctx.w)
    }
    let ay = y
    mine.forEach((a, i) => {
      parts.push(edge(PAD + leftW + 4, cy, ax, ay + AGENT_H / 2, isLive(a)))
      agentStack(parts, a, ax, ay, aw, ctx)
      ay += heights[i]! + AGENT_GAP
    })
    bottom = cy
    y += rowH + 10
  }
  if (steps.length > 0) {
    parts.unshift(`<line x1="${TRUNK}" y1="${top}" x2="${TRUNK}" y2="${bottom}" class="trunk"/>`)
  }
  return y
}

// With plans hidden: the trunk as a time axis, agents and skill rows in call order.
const drawTimeline = (
  parts: string[],
  agents: TrackedAgent[],
  skills: TrackedSkill[],
  y: number,
  top: number,
  ctx: Ctx,
) => {
  const { W, now, show } = ctx
  const ax = PAD + Math.round((W - 2 * PAD) * 0.46) + 22
  type Item = { at: number; agent?: TrackedAgent; skill?: TrackedSkill }
  const items: Item[] = [
    ...(show.agents ? trim(agents) : []).map(a => ({ at: a.startedAt, agent: a })),
    ...(show.skills ? skills : []).map(k => ({ at: k.calledAt, skill: k })),
  ].sort((p, q) => p.at - q.at)
  let bottom = top
  let i = 0
  while (i < items.length) {
    const it = items[i]!
    if (it.agent) {
      const cy = y + AGENT_H / 2
      parts.push(edge(TRUNK, cy, ax, cy, isLive(it.agent)))
      const h = agentStack(parts, it.agent, ax, y, W - PAD - ax, ctx)
      bottom = cy
      y += Math.max(TIMELINE_ROW, h + TIMELINE_ROW - AGENT_H)
      i++
    } else {
      // consecutive skills share a row of pills
      const run: TrackedSkill[] = []
      while (i < items.length && items[i]!.skill) run.push(items[i++]!.skill!)
      parts.push(skillLink(y, y + PILL_H / 2, TEXT_X))
      const h = drawPills(parts, run, TEXT_X, y, W - PAD, ctx.w)
      bottom = y + PILL_H / 2
      y += h + 6
    }
  }
  if (items.length) parts.unshift(`<line x1="${TRUNK}" y1="${top}" x2="${TRUNK}" y2="${bottom}" class="trunk"/>`)
  return y
}

/**
 * A session's name frame, the same for every session folded or not: the
 * pane's own fold triangle stands left of it. Unfolded, a stub of the trunk
 * leaves the frame's bottom, and the body picture below carries it on.
 */
export type SessionState = 'idle' | 'working' | 'waiting'

// The pane redraws every second while something runs, and a redrawn picture
// starts its animations over; each one begins as far into its cycle as the
// clock says, so a redraw carries on from where the last left off.
const phase = (now: number, dur: number) => `-${((now / 1000) % dur).toFixed(2)}s`

// Working: a soft glint sweeps along the frame's bottom edge, then rests.
const GLINT_S = 3.6
const glint = (w: number, h: number, now: number, uid: string, isOwn: boolean) => {
  // on this session's accent frame the glint is light, elsewhere the accent
  const color = isOwn ? 'var(--fg)' : 'var(--accent)'
  const x0 = 11
  const x1 = w - 9
  const len = Math.min(140, Math.max(60, (x1 - x0) * 0.3))
  // ids are page-wide when pictures share a page: one per header
  const id = `glint-${uid}`
  return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${len}" y2="0">
      <stop offset="0" stop-color="${color}" stop-opacity="0"/>
      <stop offset="0.6" stop-color="${color}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="${x0 - len} 0;${x1} 0;${x1} 0" keyTimes="0;0.7;1" dur="${GLINT_S}s" begin="${phase(now, GLINT_S)}" repeatCount="indefinite"/>
    </linearGradient></defs>
    <line x1="${x0}" y1="${h + 1}" x2="${x1}" y2="${h + 1}" class="glint" stroke="url(#${id})"/>`
}

// Waiting on the user: the whole frame knocks twice, then rests (its own
// stroke dimmed, so the knock shows on this session's accent frame too).
const KNOCK_S = 2
const knock = (w: number, h: number, now: number) =>
  `<rect x="1" y="1" width="${w}" height="${h}" rx="10" class="knock" stroke-opacity="0"><animate attributeName="stroke-opacity" values="0;0.95;0.1;0.95;0;0" keyTimes="0;0.08;0.18;0.26;0.4;1" dur="${KNOCK_S}s" begin="${phase(now, KNOCK_S)}" repeatCount="indefinite"/></rect>`

export const headerPicture = (
  name: string,
  plan: PlanStep[],
  isOwn: boolean,
  isOpen: boolean,
  liveCount: number,
  width: number,
  show: Show = SHOW_ALL,
  w: Words = WORDS,
  contextTokens?: number,
  state: SessionState = liveCount > 0 ? 'working' : 'idle',
  now = 0,
  contextPercent?: number,
): Picture => {
  const W = Math.max(200, Math.round(width))
  const FRAME_H = 38
  const H = isOpen ? 48 : 40
  const done = plan.filter(s => s.status === 'completed').length
  const count = show.plans && plan.length > 0 ? `${done}/${plan.length}` : ''
  const isFull = !!contextTokens && (contextPercent ?? 0) >= CONTEXT_WARN_PERCENT
  const ctxLabel = contextTokens ? `${w.inContext(contextTokens)}${isFull ? ` · ${w.contextFull(contextPercent!)}` : ''}` : ''
  const ctxX = W - 14 - (count ? count.length * 8 + 12 : 0)
  const rightW = (count ? count.length * 8 + 14 : 0) + (ctxLabel ? ctxLabel.length * 6.2 + 12 : 0)
  const nameChars = Math.floor((W - 28 - rightW) / 8.2)
  const parts = [
    `<title>${esc(`${name}${isOwn ? w.thisSessionTip : ''}${liveCount ? `\n${w.runningTip(liveCount)}` : ''}`)}</title>`,
    `<rect x="1" y="1" width="${W - 2}" height="${FRAME_H}" rx="10" class="frame ${isOwn ? 'own' : ''} ${state === 'waiting' ? 'wait' : ''}"/>`,
    `<text x="14" y="25" class="head">${esc(cut(name, nameChars))}</text>`,
    count ? `<text x="${W - 14}" y="25" class="count end ${done === plan.length ? 'okfill' : ''}">${count}</text>` : '',
    ctxLabel ? `<text x="${ctxX}" y="24" class="tiny end${isFull ? ' warntext' : ''}">${esc(ctxLabel)}</text>` : '',
    isOpen ? `<line x1="${TRUNK}" y1="${FRAME_H + 1}" x2="${TRUNK}" y2="${H}" class="trunk"/>` : '',
    state === 'working' ? glint(W - 2, FRAME_H, now, digest(`${isOwn ? 'own' : ''}:${name}`), isOwn) : state === 'waiting' ? knock(W - 2, FRAME_H, now) : '',
  ]
  return picture(W, H, parts)
}

/** What hangs off a session's frame: its current plan (or time axis), agents, skills. */
export const bodyPicture = (
  snap: SessionSnapshot,
  now: number,
  width: number,
  show: Show = SHOW_ALL,
  w: Words = WORDS,
  tokens = true,
): Picture => {
  const W = Math.max(300, Math.round(width))
  const ctx: Ctx = { W, now, show, agentSkills: skillsOfAgent(snap), w, tokens, children: childrenMap(snap) }
  const ag = assignAgents(snap)
  const sk = assignSkills(snap)
  const parts: string[] = []
  let y = 8

  if (!show.plans) {
    const allSkills = (snap.skills ?? []).filter(k => !k.by)
    y = drawTimeline(parts, topAgents(snap), allSkills, y, 0, ctx)
  } else {
    // what ran with no plan hangs off the frame, above the plan
    const looseAgents = show.agents ? trim(splitLoose(snap).fresh) : []
    const ax = PAD + Math.round((W - 2 * PAD) * 0.46) + 22
    for (const a of looseAgents) {
      parts.push(edge(TRUNK, 0, ax, y + AGENT_H / 2, isLive(a)))
      y += agentStack(parts, a, ax, y, W - PAD - ax, ctx) + AGENT_GAP
    }
    if (show.skills && sk.loose.length) {
      parts.push(skillLink(0, y + PILL_H / 2, TEXT_X))
      y += drawPills(parts, sk.loose, TEXT_X, y, W - PAD, ctx.w) + 4
    }
    if (looseAgents.length) y += 4
    y = drawPlan(parts, snap.plan, ag.current, sk.current, y, 0, ctx)
  }
  const isEmpty = parts.length === 0
  const H = isEmpty ? 0 : Math.max(20, Math.round(y + 2))
  return picture(W, H, parts, isEmpty)
}

/** Finished agents that ran under no plan step before the latest message or plan. */
export const earlierPicture = (
  snap: SessionSnapshot,
  now: number,
  width: number,
  w: Words = WORDS,
  tokens = true,
): Picture => {
  const W = Math.max(300, Math.round(width))
  const ctx: Ctx = { W, now, show: SHOW_ALL, agentSkills: skillsOfAgent(snap), w, tokens, children: childrenMap(snap) }
  const parts: string[] = []
  const ax = PAD + 6
  let y = PAD
  for (const a of [...splitLoose(snap).earlier].reverse().slice(0, 10)) {
    y += agentStack(parts, a, ax, y, W - PAD - ax, ctx) + AGENT_GAP
  }
  return picture(W, Math.max(20, Math.round(y + PAD - AGENT_GAP)), parts, parts.length === 0)
}

/** One finished plan with the agents and skills that ran under it. */
export const planPicture = (
  snap: SessionSnapshot,
  index: number,
  now: number,
  width: number,
  show: Show = SHOW_ALL,
  w: Words = WORDS,
  tokens = true,
): Picture => {
  const W = Math.max(300, Math.round(width))
  const steps = snap.history?.[index]?.steps ?? []
  const ctx: Ctx = { W, now, show, agentSkills: skillsOfAgent(snap), w, tokens, children: childrenMap(snap) }
  const parts: string[] = []
  const y = drawPlan(parts, steps, assignAgents(snap).past[index] ?? [], assignSkills(snap).past[index] ?? [], PAD, PAD, ctx, true)
  return picture(W, Math.max(40, Math.round(y + PAD - 10)), parts)
}

// ---- usage statistics ------------------------------------------------------------

/** 1204 → «1 204» (thin space). */
export const groupDigits = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/**
 * A ranking as rows of 28px: the name (a skill's prefix before «:» dimmed),
 * the count at the right in tabular figures, and under the name a thin bar
 * over a faint track, the leader a little brighter. No orange: nothing here runs.
 */
export const rankingPicture = (rows: [string, number][], max: number, width: number): Picture => {
  const W = Math.max(200, Math.round(width))
  const trackW = W - 48
  const nameChars = Math.floor((W - 56) / 7.5)
  const parts = rows.map(([name, n], i) => {
    const y0 = i * 28
    const colon = name.lastIndexOf(':')
    const shown = cut(name, nameChars)
    const prefix = colon > 0 && colon < shown.length ? shown.slice(0, colon + 1) : ''
    const rest = prefix ? shown.slice(prefix.length) : shown
    const barW = Math.max(4, Math.round((trackW * n) / Math.max(1, max)))
    return `<g><title>${esc(`${name}: ${n}`)}</title>
      <text x="0" y="${y0 + 14}" class="rname">${prefix ? `<tspan class="rpre">${esc(prefix)}</tspan>` : ''}${esc(rest)}</text>
      <text x="${W}" y="${y0 + 14}" class="rnum end">${groupDigits(n)}</text>
      <rect x="0" y="${y0 + 19}" width="${trackW}" height="4" rx="2" class="rtrack"/>
      <rect x="0" y="${y0 + 19}" width="${barW}" height="4" rx="2" class="rbar ${i === 0 ? 'lead' : ''}"/></g>`
  })
  return picture(W, Math.max(28, rows.length * 28), parts)
}
