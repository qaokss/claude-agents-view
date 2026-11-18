import type { EngineInterface } from 'claude-code'

import type { AgentStatusWord, ExternalRun, ExternalVendor, TrackedAgent } from '../types'

// Other frontier CLIs Claude starts through Bash: OpenAI's Codex and Google's
// Gemini CLI. Neither tells Claude Code what it does, but both keep a log of
// every session on disk, so the pane finds the log a run wrote and reads it:
//
//   Codex   $CODEX_HOME (~/.codex)/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl
//           line 1 `session_meta` (thread id, cwd, parent thread for a
//           subagent), then `event_msg` lines: `token_count`, `task_started`,
//           `task_complete`, `turn_aborted`; `turn_context` names the model.
//   Gemini  ~/.gemini/tmp/<project>/chats/session-…-<id>.jsonl, the project
//           folder named in `<project>/.project_root`; line 1 the metadata
//           (`sessionId`, `startTime`, `kind`), then one line per message
//           (written again, same `id`, when it changes) with `tokens`. A
//           subagent's chat is `chats/<parent sessionId>/<its sessionId>.jsonl`.
//
// A run's own agents become children (`parentId`) of the run's card, and
// theirs of theirs.

export const VENDOR_NAME: Record<ExternalVendor, string> = { codex: 'Codex', gemini: 'Gemini' }

// `codex …`, `npx @openai/codex …`, `gemini …`, `npx -y @google/gemini-cli@1 …`
// at the head of a command in a shell line (after `&&`, `;`, `|`, `(`, a
// variable set before it, `nohup`, `time`, `timeout 600`, `env`), not as a word
// in another command's arguments.
const CLI_PATTERN =
  /(?:^|[;&|(`]|\$\()\s*(?:\w+=\S*\s+)*(?:(?:nohup|time|env|exec|timeout\s+\S+)\s+)*(?:(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx)\s+(?:(?:-y|--yes)\s+)?)?(?:(@openai\/codex|codex)|(@google\/gemini-cli|gemini))(?:@\S*)?(?=\s|$|[;&|)])/
// What only asks about the CLI, not a run of it.
const NOT_A_RUN = /\s--(?:version|help)\b|\s-[vh]\b|\b(?:codex|gemini)\s+(?:login|logout|mcp|completion|auth)\b|\b(?:which|type|command\s+-v)\s+(?:codex|gemini)\b/

/** Which frontier CLI a shell command runs, if any. */
export const vendorOf = (command: string): ExternalVendor | undefined => {
  const m = CLI_PATTERN.exec(command)
  if (!m || NOT_A_RUN.test(command)) return undefined
  return m[1] ? 'codex' : 'gemini'
}

const unquote = (p: string) => p.replace(/^(["'])(.*)\1$/, '$2')
const resolvePath = (p: string, cwd: string, home: string) => {
  const raw = unquote(p)
  const abs = raw.startsWith('/') ? raw : raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : `${cwd.replace(/\/+$/, '')}/${raw}`
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * The folder a CLI run works in: the session's, moved by a `cd <dir> &&`
 * before it, or Codex's own `-C <dir>` / `--cd <dir>`.
 */
export const runDir = (command: string, cwd: string, home: string) => {
  let dir = cwd
  const at = CLI_PATTERN.exec(command)?.index ?? command.length
  const before = command.slice(0, at)
  for (const m of before.matchAll(/(?:^|[;&(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) dir = resolvePath(m[1]!, dir, home)
  const own = /\s(?:-C|--cd)[\s=]("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command.slice(at))
  if (own && vendorOf(command) === 'codex') dir = resolvePath(own[1]!, dir, home)
  return dir
}

// ---- reading logs a few lines at a time ------------------------------------------

type Tail = { offset: number; size: number; mtimeMs: number }
const tails = new Map<string, Tail>()

/**
 * The complete lines added to a file since the last call, parsed; [] when
 * nothing changed. `$.fs.read` reads whole files only, so the new part comes
 * from `tail -c +N`, at most 4 MiB a call; a line not yet ended is read next
 * time, from its start.
 */
async function newLines($: EngineInterface, path: string, size: number, mtimeMs: number) {
  const tail = tails.get(path) ?? { offset: 0, size: -1, mtimeMs: 0 }
  if (tail.size === size && tail.mtimeMs === mtimeMs) return []
  if (size < tail.offset) tail.offset = 0
  const out: Record<string, unknown>[] = []
  if (tail.offset < size) {
    const ran = await $.process.run(['tail', '-c', `+${tail.offset + 1}`, path], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) return []
    const text = ran.stdout
    const end = text.lastIndexOf('\n')
    if (end >= 0) {
      const whole = text.slice(0, end + 1)
      tail.offset += utf8Length(whole)
      for (const line of whole.split('\n')) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // a damaged line is skipped
        }
      }
    }
  }
  tail.size = size
  tail.mtimeMs = mtimeMs
  tails.set(path, tail)
  return out
}

const utf8Length = (s: string) => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const timeOf = (iso: unknown) => {
  const t = Date.parse(str(iso))
  return Number.isFinite(t) ? t : 0
}
const flat = (s: string, max: number) => {
  const f = s.replace(/\s+/g, ' ').trim()
  return f.length > max ? f.slice(0, max - 1) + '…' : f
}

/** One session log as the pane knows it so far. */
export type LogState = {
  path: string
  vendor: ExternalVendor
  /** Codex thread id or Gemini sessionId. */
  id: string
  parent?: string
  cwd: string
  startedAt: number
  /** When it last changed, by the file's mtime. */
  touchedAt: number
  name: string
  model?: string
  status: AgentStatusWord
  endedAt?: number
  tokens: number
  // Codex: the last request's input, and all output.
  lastInput: number
  output: number
  // Gemini: messages by id, last write wins.
  messages?: Map<string, { type: string; input: number; out: number; text: string; pending: boolean }>
}

/** Folds a Codex rollout's new lines into its state. */
export const readCodexLines = (s: LogState, lines: Record<string, unknown>[]) => {
  for (const line of lines) {
    const type = str(line.type)
    const p = obj(line.payload)
    if (type === 'session_meta') {
      s.id = str(p.id) || s.id
      s.cwd = str(p.cwd) || s.cwd
      s.startedAt = timeOf(p.timestamp) || timeOf(line.timestamp) || s.startedAt
      const spawn = obj(obj(obj(p.source).subagent).thread_spawn)
      const parent = str(p.parent_thread_id) || str(spawn.parent_thread_id)
      if (parent) s.parent = parent
      const nick = str(p.agent_nickname) || str(spawn.agent_nickname)
      const role = str(p.agent_role) || str(spawn.agent_role) || str(spawn.agent_type)
      if (nick || role) s.name = [nick, role && nick ? `(${role})` : role].filter(Boolean).join(' ')
    } else if (type === 'turn_context') {
      if (str(p.model)) s.model = str(p.model)
    } else if (type === 'event_msg') {
      const ev = str(p.type)
      if (ev === 'token_count') {
        const info = obj(p.info)
        const total = obj(info.total_token_usage)
        const last = obj(info.last_token_usage)
        if (Object.keys(total).length) {
          s.lastInput = num(last.input_tokens)
          s.output = num(total.output_tokens)
          s.tokens = s.lastInput + s.output
        }
      } else if (ev === 'task_started' || ev === 'turn_started') {
        s.status = 'running'
        s.endedAt = undefined
      } else if (ev === 'task_complete' || ev === 'turn_complete') {
        s.status = 'completed'
        s.endedAt = timeOf(line.timestamp) || s.touchedAt
      } else if (ev === 'turn_aborted') {
        s.status = 'killed'
        s.endedAt = timeOf(line.timestamp) || s.touchedAt
      } else if (ev === 'user_message' && !s.name) {
        s.name = flat(str(p.message), 80)
      }
    }
  }
}

/** Folds a Gemini chat's new lines into its state. */
export const readGeminiLines = (s: LogState, lines: Record<string, unknown>[]) => {
  const msgs = (s.messages ??= new Map())
  const take = (m: Record<string, unknown>) => {
    const tokens = obj(m.tokens)
    const content = m.content
    const text = Array.isArray(content)
      ? content.map(c => str(obj(c).text)).join('')
      : str(content)
    const calls = Array.isArray(m.toolCalls) ? (m.toolCalls as unknown[]).map(obj) : []
    msgs.set(str(m.id), {
      type: str(m.type),
      input: num(tokens.input),
      out: num(tokens.output) + num(tokens.thoughts),
      text,
      // a tool call with no result yet: the model is waiting on it
      pending: calls.some(c => !('result' in c) && str(c.status) !== 'success' && str(c.status) !== 'error' && str(c.status) !== 'cancelled'),
    })
    if (str(m.model)) s.model = str(m.model)
  }
  for (const line of lines) {
    const set = obj(line.$set)
    if ('$set' in line) {
      if (Array.isArray(set.messages)) {
        msgs.clear()
        for (const m of set.messages) if (typeof obj(m).id === 'string') take(obj(m))
      }
      continue
    }
    if (typeof line.id === 'string' && !('$patch' in line)) {
      take(line)
      continue
    }
    if (typeof line.sessionId === 'string') {
      s.id = line.sessionId
      s.startedAt = timeOf(line.startTime) || s.startedAt
    }
  }
  let last = 0
  let out = 0
  for (const m of msgs.values()) {
    if (m.type !== 'gemini') continue
    if (m.input) last = m.input
    out += m.out
  }
  s.lastInput = last
  s.output = out
  s.tokens = last + out
  if (!s.name) {
    const first = [...msgs.values()].find(m => m.type === 'user' && m.text.trim())
    if (first) s.name = flat(first.text, 80)
  }
}

/** A Gemini chat looks done when its last message is the model's with no tool call pending. */
export const geminiAtRest = (s: LogState) => {
  const all = [...(s.messages ?? new Map()).values()]
  const last = all[all.length - 1]
  return !!last && last.type === 'gemini' && !last.pending
}

// ---- where the logs are ------------------------------------------------------------

type Found = { path: string; size: number; mtimeMs: number; vendor: ExternalVendor; project?: string; parentDir?: string }

const pad = (n: number) => String(n).padStart(2, '0')
const codexDays = (from: number, to: number) => {
  const days = new Set<string>()
  for (let t = from - 86_400_000; t <= to + 86_400_000; t += 43_200_000) {
    const d = new Date(t)
    days.add(`${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`)
    days.add(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`)
  }
  return [...days]
}

async function listFiles($: EngineInterface, dir: string) {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

async function homes($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const codex = (await $.env.get('CODEX_HOME')) || `${home}/.codex`
  const gemini = `${(await $.env.get('GEMINI_CLI_HOME')) || home}/.gemini`
  return { codex, gemini }
}

const projectRoots = new Map<string, string>()

/** Every log file touched since `since`. */
async function findLogs($: EngineInterface, vendors: Set<ExternalVendor>, since: number, t: number): Promise<Found[]> {
  const { codex, gemini } = await homes($)
  const found: Found[] = []
  if (vendors.has('codex')) {
    for (const day of codexDays(since, t)) {
      const dir = `${codex}/sessions/${day}`
      for (const f of await listFiles($, dir)) {
        if (f.kind === 'file' && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl') && f.mtimeMs >= since) {
          found.push({ path: `${dir}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs, vendor: 'codex' })
        }
      }
    }
  }
  if (vendors.has('gemini')) {
    const tmp = `${gemini}/tmp`
    for (const p of await listFiles($, tmp)) {
      if (p.kind !== 'dir') continue
      const chats = `${tmp}/${p.name}/chats`
      const files = await listFiles($, chats)
      if (files.length === 0) continue
      let project = projectRoots.get(p.name)
      if (project === undefined) {
        try {
          project = (await $.fs.read(`${tmp}/${p.name}/.project_root`)).trim()
        } catch {
          project = ''
        }
        projectRoots.set(p.name, project)
      }
      for (const f of files) {
        if (f.kind === 'file' && f.name.startsWith('session-') && f.name.endsWith('.jsonl') && f.mtimeMs >= since) {
          found.push({ path: `${chats}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs, vendor: 'gemini', project })
        } else if (f.kind === 'dir') {
          for (const g of await listFiles($, `${chats}/${f.name}`)) {
            if (g.kind === 'file' && g.name.endsWith('.jsonl') && g.mtimeMs >= since) {
              found.push({ path: `${chats}/${f.name}/${g.name}`, size: g.size, mtimeMs: g.mtimeMs, vendor: 'gemini', project, parentDir: f.name })
            }
          }
        }
      }
    }
  }
  return found
}

// ---- runs and their logs -----------------------------------------------------------------

const logs = new Map<string, LogState>()
const claimed = new Map<string, string>() // log path → run id

/** For tests: forget every log read. */
export const resetExternal = () => {
  tails.clear()
  logs.clear()
  claimed.clear()
  projectRoots.clear()
}

const sameTree = (a: string, b: string) => {
  if (!a || !b) return true
  const x = a.replace(/\/+$/, '')
  const y = b.replace(/\/+$/, '')
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

// How long a Gemini chat must stay still, its last word the model's, to count
// as done when nothing else says so.
const QUIET_MS = 20_000
// A run whose log never turns up stops being looked for.
const GIVE_UP_MS = 10 * 60_000

/**
 * Reads what changed in every log of the runs given and answers each run's
 * card and its agents' cards, keyed by run id.
 */
export async function pollRuns($: EngineInterface, runs: ExternalRun[], t: number) {
  const out = new Map<string, TrackedAgent[]>()
  if (runs.length === 0) return out
  const since = Math.min(...runs.map(r => r.startedAt)) - 5_000
  const found = await findLogs($, new Set(runs.map(r => r.vendor)), since, t)
  for (const f of found) {
    const known = logs.get(f.path)
    const s: LogState = known ?? {
      path: f.path,
      vendor: f.vendor,
      id: '',
      cwd: f.project ?? '',
      startedAt: f.mtimeMs,
      touchedAt: f.mtimeMs,
      name: '',
      status: 'running',
      tokens: 0,
      lastInput: 0,
      output: 0,
    }
    if (f.parentDir) s.parent = f.parentDir
    const lines = await newLines($, f.path, f.size, f.mtimeMs).catch(() => [])
    if (lines.length) {
      s.touchedAt = f.mtimeMs
      if (f.vendor === 'codex') readCodexLines(s, lines)
      else readGeminiLines(s, lines)
    }
    if (f.vendor === 'gemini' && !s.id) s.id = f.path.split('/').pop()!.replace(/\.jsonl$/, '')
    logs.set(f.path, s)
  }

  for (const run of runs) {
    // its main session: the first unclaimed top-level log of its CLI, in its
    // folder, begun once it started
    if (!run.path) {
      const pick = [...logs.values()]
        .filter(
          s =>
            s.vendor === run.vendor &&
            !s.parent &&
            !claimed.has(s.path) &&
            s.startedAt >= run.startedAt - 5_000 &&
            sameTree(s.cwd, run.cwd),
        )
        .sort((a, b) => a.startedAt - b.startedAt)[0]
      if (pick) {
        run.path = pick.path
        claimed.set(pick.path, run.id)
      }
    }
    const main = run.path ? logs.get(run.path) : undefined
    const cards: TrackedAgent[] = []
    // the run itself
    let status: AgentStatusWord = 'running'
    let endedAt: number | undefined
    if (run.returnedAt !== undefined) {
      status = run.returnedOk === false ? 'failed' : 'completed'
      endedAt = run.returnedAt
    } else if (main && main.status !== 'running') {
      status = main.status
      endedAt = main.endedAt
    } else if (main && main.vendor === 'gemini' && run.isBackground && geminiAtRest(main) && t - main.touchedAt > QUIET_MS) {
      status = 'completed'
      endedAt = main.touchedAt
    } else if (!main && t - run.startedAt > GIVE_UP_MS && run.isBackground) {
      status = 'idle'
    }
    cards.push({
      id: run.id,
      description: '',
      type: '',
      prompt: '',
      status,
      startedAt: run.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      toolCalls: 0,
      vendor: run.vendor,
      ...(main?.model ? { model: main.model } : {}),
      ...(main?.tokens ? { tokens: main.tokens } : {}),
    })
    // its agents, and theirs: logs whose parent is a thread of this tree
    if (main) {
      const ids = new Map<string, string>([[main.id, run.id]])
      let grew = true
      while (grew) {
        grew = false
        for (const s of logs.values()) {
          if (!s.parent || ids.has(s.id) || !ids.has(s.parent) || s.vendor !== run.vendor) continue
          const cardId = `${run.id}/${s.id}`
          ids.set(s.id, cardId)
          grew = true
          const runEnded = status !== 'running'
          let st: AgentStatusWord = s.status
          let end = s.endedAt
          if (s.vendor === 'gemini' && st === 'running' && geminiAtRest(s) && (runEnded || t - s.touchedAt > QUIET_MS)) {
            st = 'completed'
            end = s.touchedAt
          }
          if (runEnded && st === 'running') {
            st = 'completed'
            end = endedAt ?? s.touchedAt
          }
          cards.push({
            id: cardId,
            parentId: ids.get(s.parent)!,
            description: s.name,
            type: '',
            prompt: '',
            status: st,
            startedAt: s.startedAt,
            ...(end !== undefined ? { endedAt: end } : {}),
            toolCalls: 0,
            vendor: s.vendor,
            ...(s.model ? { model: s.model } : {}),
            ...(s.tokens ? { tokens: s.tokens } : {}),
          })
        }
      }
    }
    out.set(run.id, cards)
  }
  return out
}

/** Whether the pane still needs to read a run's logs. */
export const isFollowed = (run: ExternalRun, cards: TrackedAgent[] | undefined, t: number) => {
  const live = (cards ?? []).some(c => c.status === 'running' || c.status === 'pending')
  const ended = run.returnedAt ?? Math.max(0, ...(cards ?? []).map(c => c.endedAt ?? 0))
  // a little longer after it ends, for the last token counts to land
  return live || t - ended < 30_000 || (!run.path && t - run.startedAt < GIVE_UP_MS)
}
