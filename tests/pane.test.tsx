import { expect, mock, test } from 'claude-code/testing'

import { runDir, vendorOf } from '../hooks/external'

const PANE = {
  plugin: 'subagents-pane',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Agents, skills & plans',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('a spawned subagent shows with its task and status', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await empty.find({ type: 'Text', text: /No plan, no subagents yet/ })).toBeTruthy()
  await empty.unmount()

  await $.agent.spawn({ prompt: 'Find every TODO in src', description: 'Find TODOs', subagentType: 'Explore' } as never)

  await clock.advance(65_000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Find TODOs/ }))?.text).toBe('Find TODOs')
    expect(await ui.find({ type: 'Text', text: /^◐$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1:05$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Explore · 0 calls/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Subagents · 1/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a finished turn marks the subagent done', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a2' }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.agent.spawn({ prompt: 'Run tests', description: 'Tests', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ turnId: 't1', agentId: 'a2', reason: 'answer', answer: 'done' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Finished subagents \(1\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Tests$/ })).toBeFalsy()
  await ui.press({ key: 'btn-done:' })
  expect(await ui.find({ type: 'Text', text: /^Tests$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeTruthy()
  await ui.unmount()
})

test('the plan list shows its steps as they move', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'Step one', status: 'in_progress' },
    { content: 'Step two', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Plan/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Step two/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^◐$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeTruthy()
  await ui.unmount()
})

test('other sessions show up from the shared folder', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const dir = '/home/u/.claude/mods-data/subagents-pane/sessions'
  const other = {
    sessionId: 'other-1', title: '', folder: 'demo-app', topic: 'Review the call screen',
    plan: [{ content: 'Call status badge', status: 'in_progress' }],
    history: [],
    agents: [{ id: 'x1', description: 'UI review', type: 'ui-designer', prompt: 'Check', status: 'running', startedAt: 4_990_000, toolCalls: 3 }],
    updatedAt: 4_999_000,
  }
  const written: string[] = []
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_, e) => (written.push((e as { path: string }).path), { value: undefined }))
  on('fs.list', () => ({ value: [
    { name: 'me-1.json', kind: 'file', size: 1, mtimeMs: 4_999_000, isLink: false },
    { name: 'other-1.json', kind: 'file', size: 1, mtimeMs: 4_999_000, isLink: false },
  ] }))
  on('fs.read', () => ({ value: JSON.stringify(other) }))

  await $.session.start({ cwd: '/Users/u/scratch', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^scratch$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Review the call screen/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Call status badge/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /UI review/ })).toBeTruthy()
  expect(written).toContain(`${dir}/me-1.json`)
  await ui.unmount()
})

test('the chat title heads the session, and a finished plan folds away', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_, e) => {
    const path = (e as { path?: string }).path ?? ''
    return { value: path.endsWith('/.claude/projects')
      ? [{ name: '-Users-u-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [] }
  })
  on('fs.exists', (_, e) => ({ value: !String((e as { path?: string }).path).includes('mods-data') }))
  on('fs.read', () => ({ value: JSON.stringify({ customTitle: 'Subagents status pane' }) }))

  await $.session.start({ cwd: '/Users/u/workspace-2026', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'First step', status: 'completed' },
    { content: 'Second step', status: 'completed' },
  ] } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Subagents status pane$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /workspace-2026/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /First step/ })).toBeFalsy()
  await ui.press({ key: 'btn-plan:me-1' })
  expect(await ui.find({ type: 'Text', text: /First step/ })).toBeTruthy()
  await ui.unmount()
})

test('a replaced plan stays under past plans', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Old step', status: 'completed' }] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'New step', status: 'in_progress' }] } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /New step/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Past plans \(1\)/ })).toBeTruthy()
  await ui.press({ key: 'btn-history:' })
  expect(await ui.find({ type: 'Text', text: /1\/1 · Old step/ })).toBeTruthy()
  await ui.unmount()
})

test('another session is named by its chat title even if it sent none', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const other = {
    sessionId: 'other-1', folder: 'spare', topic: 'my long prompt',
    plan: [], agents: [], updatedAt: 4_999_000,
  }
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: !String((e as { path?: string }).path).includes('me-1/') }))
  on('fs.list', (_, e) => {
    const path = (e as { path?: string }).path ?? ''
    return { value: path.endsWith('/.claude/projects')
      ? [{ name: '-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 'other-1.json', kind: 'file', size: 1, mtimeMs: 4_999_000, isLink: false }] }
  })
  on('fs.read', (_, e) => ({ value: String((e as { path?: string }).path).endsWith('custom-title.json')
    ? JSON.stringify({ customTitle: 'Full QA pass' })
    : JSON.stringify(other) }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Full QA pass/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /my long prompt/ })).toBeFalsy()
  await ui.unmount()
})

test('the view button switches the pane to a graph on desktop', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'g1' }))
  on('tool.call', () => ({ result: {} }))

  await $.agent.spawn({ prompt: 'Check', description: 'API audit', subagentType: 'security-auditor' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'btn-view-graph' } as never)).toBeTruthy()
  await ui.press({ key: 'btn-view-graph' })
  const svg = await ui.findAll({ type: 'Svg' })
  expect(svg.length).toBeGreaterThan(0)
  expect(JSON.stringify(svg)).toContain('API audit')
  await ui.press({ key: 'btn-view-list' })
  expect(await ui.find({ type: 'Svg' })).toBeFalsy()
  await ui.press({ key: 'btn-view-graph' })
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeFalsy()
  expect(await term.find({ type: 'Text', text: /API audit/ })).toBeTruthy()
  await term.unmount()
})

test('a subagent hangs off the plan step it was spawned under, with its tools', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'k1' }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Check the API', status: 'in_progress' }] } as never)
  await $.agent.spawn({ prompt: 'Check', description: 'Audit', subagentType: 'security-auditor' } as never)
  await $.tool.call({ tool: 'Grep', agentId: 'k1', pattern: 'x' } as never)
  await $.tool.call({ tool: 'Grep', agentId: 'k1', pattern: 'y' } as never)
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'k1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 60 } })
  await ui.press({ key: 'btn-view-graph' })
  const svg = JSON.stringify(await ui.findAll({ type: 'Svg' }))
  expect(svg).toContain('Check the API')
  expect(svg).toContain('Grep 2')
  expect(svg).not.toContain('SubagentHandback')
  expect(svg).toContain('viewBox=\\"0 0 522 ')
  const els = (await ui.findAll({ type: 'Svg' })) as unknown as { props: { width?: number } }[]
  expect(els[0]!.props.width).toBe(522)
  await ui.unmount()
})

test('in the graph, past plans fold away and keep their own agents', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'p1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Old step', status: 'in_progress' }] } as never)
  await $.agent.spawn({ prompt: 'x', description: 'Old agent', subagentType: 'Explore' } as never)
  await $.turn.complete({ turnId: 't', agentId: 'p1', reason: 'answer', answer: 'ok' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'New step', status: 'in_progress' }] } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'btn-view-graph' })
  const main = JSON.stringify(await ui.findAll({ type: 'Svg' }))
  expect(main).toContain('New step')
  expect(main).not.toContain('Old agent')
  expect(await ui.find({ type: 'Text', text: /Past plans \(1\) · 1 subagent/ })).toBeTruthy()
  await ui.press({ key: 'btn-history:' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
  await ui.press({ key: (await ui.findAll({ type: 'Button' })).map(b => (b as unknown as { key: string }).key).find(k => k.startsWith('btn-past:'))! })
  const pics = await ui.findAll({ type: 'Svg' })
  expect(pics).toHaveLength(3)
  expect(JSON.stringify(pics[2])).toContain('Old agent')
  expect(JSON.stringify(pics[2])).toContain('Old step')
  await ui.unmount()
})

test('wrapping up checks off every step, and a replaced plan shows its dropped steps', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'Step A', status: 'in_progress' }, { content: 'Step B', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'ok' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Plan · 2\/2/ })).toBeTruthy()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [
    { content: 'Step C', status: 'in_progress' }, { content: 'Step D', status: 'pending' },
  ] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Fresh', status: 'in_progress' }] } as never)
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui2.press({ key: 'btn-history:' })
  expect(await ui2.find({ type: 'Text', text: /0\/2 · Step C · replaced/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /2\/2 · Step A$/ })).toBeTruthy()
  await ui2.unmount()
})

test('in the graph, another session folds to its header', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const other = {
    sessionId: 'o2', title: 'Full QA pass', folder: 'x', topic: '',
    plan: [{ content: 'Manual web test', status: 'in_progress' }], history: [], agents: [], updatedAt: 4_999_000,
  }
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: String((e as { path?: string }).path).includes('mods-data') }))
  on('fs.list', () => ({ value: [{ name: 'o2.json', kind: 'file', size: 1, mtimeMs: 4_999_000, isLink: false }] }))
  on('fs.read', () => ({ value: JSON.stringify(other) }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'btn-view-graph' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.press({ key: 'btn-session:o2' })
  const folded = await ui.findAll({ type: 'Svg' })
  expect(folded).toHaveLength(2)
  expect(JSON.stringify(folded[1])).toContain('Full QA pass')
  expect(JSON.stringify(folded)).not.toContain('Manual web test')
  await ui.press({ key: 'btn-all' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})

test('a resumed subagent keeps its tool counts', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'r1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.agent.spawn({ prompt: 'x', description: 'Design', subagentType: 'ui-designer' } as never)
  await $.tool.call({ tool: 'Read', agentId: 'r1', file_path: '/a' } as never)
  await $.tool.call({ tool: 'Read', agentId: 'r1', file_path: '/b' } as never)
  await $.turn.complete({ turnId: 't', agentId: 'r1', reason: 'answer', answer: 'ok' } as never)
  await $.agent.spawn({ prompt: 'y', description: 'Design', subagentType: 'ui-designer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ui-designer · 2 calls/ })).toBeTruthy()
  await ui.unmount()
})

test('skills show in the list, and filters hide each kind', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: { success: true, commandName: 'x' } }))

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Step', status: 'in_progress' }] } as never)
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:docx' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:docx' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^docx/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^×2$/ })).toBeTruthy()
  await ui.press({ key: 'btn-show-skills' })
  expect(await ui.find({ type: 'Text', text: /^docx/ })).toBeFalsy()
  await ui.press({ key: 'btn-show-plans' })
  expect(await ui.find({ type: 'Text', text: /Plan ·/ })).toBeFalsy()
  await ui.press({ key: 'btn-show-agents' })
  expect(await ui.find({ type: 'Text', text: /Everything is filtered out/ })).toBeTruthy()
  await ui.press({ key: 'btn-show-skills' })
  await ui.press({ key: 'btn-view-graph' })
  expect(JSON.stringify(await ui.findAll({ type: 'Svg' }))).toContain('docx ×2')
  await ui.unmount()
})

test('the statistics button opens the all-time ranking from transcripts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const line = (id: string, body: string) => `"id":"${id}","name":${body}`
  const grepOut = [
    line('toolu_1', '"Skill","input":{"skill":"anthropic-skills:docx"'),
    line('toolu_1', '"Skill","input":{"skill":"anthropic-skills:docx"'),
    line('toolu_2', '"Skill","input":{"skill":"anthropic-skills:docx","args":"x"'),
    line('toolu_3', '"Agent","input":{"description":"A","subagent_type":"ui-designer"'),
    line('toolu_4', '"Agent","input":{"description":"B","prompt":"p"'),
  ].join('\n')
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: String((e as { path?: string }).path).endsWith('/.claude/projects') }))
  on('fs.list', (_, e) => {
    const path = (e as { path?: string }).path ?? ''
    return { value: path.endsWith('/.claude/projects')
      ? [{ name: '-p', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 'a.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'b.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: grepOut, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Statistics ▴/ })).toBeTruthy()
  await ui.press({ key: 'btn-stats' })
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /All time · 2 sessions/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Skills · 2 calls/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Subagents · 2 runs/ })).toBeTruthy()
  const pics = JSON.stringify(await ui.findAll({ type: 'Svg' }))
  expect(pics).toContain('docx')
  expect(pics).toContain('general-purpose')
  await ui.unmount()
})

test('both commands open the pane', async ($, on) => {
  const opened: string[] = []
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }))
  on('ui.open', (_, e) => (opened.push((e as { title: string }).title), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const a = await $.command.run({ command: 'agents-view', args: '' } as never)
  const b = await $.command.run({ command: 'subagents', args: '' } as never)
  expect(JSON.stringify(a)).toContain('opened')
  expect(JSON.stringify(b)).toContain('opened')
  expect(opened).toContain('Agents, skills & plans')
})

test('subagent tokens and the session context show, and settings hide them', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let tokenCount = 0
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 152_400, window: 200_000 }, rateLimits: [] } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 't1' }))
  on('agent.list', () => ({ value: tokenCount
    ? [{ id: 't1', description: 'Digest notes', type: 'Explore', status: 'running', tokenCount, tokenSamples: [], kind: 'local_agent', taskStatus: 'running', label: '', startTime: 0, cwd: '/', hasRow: true }]
    : [] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Digest notes', subagentType: 'Explore' } as never)
  tokenCount = 142_812
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Explore · 0 calls · 142\.8k tokens/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /152\.4k in context · this session/ })).toBeTruthy()
  await ui.press({ key: 'btn-view-graph' })
  const svg = JSON.stringify(await ui.findAll({ type: 'Svg' }))
  expect(svg).toContain('142.8k tokens')
  expect(svg).toContain('152.4k in context')

  await ui.press({ key: 'btn-settings' })
  expect(await ui.find({ type: 'Text', text: /● Token usage/ })).toBeTruthy()
  await ui.press({ key: 'btn-set-tokens' })
  expect(await ui.find({ type: 'Text', text: /○ Token usage/ })).toBeTruthy()
  expect(JSON.stringify(await ui.findAll({ type: 'Svg' }))).not.toContain('tokens')
  await ui.press({ key: 'btn-view-list' })
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /in context/ })).toBeFalsy()
  await ui.unmount()
})

// ---- Codex and Gemini runs ---------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString()
const bytes = (s: string) => new TextEncoder().encode(s).length
/** A fake disk: files by path, and the listing each folder gives. */
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
const disk = (on: TestOn, files: Record<string, string>, mtime: () => number) => {
  on('fs.list', (_, e) => {
    const dir = String((e as { path?: string }).path).replace(/\/+$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(files)) {
      if (!p.startsWith(`${dir}/`)) continue
      const rest = p.slice(dir.length + 1).split('/')
      names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({
      name, kind, size: kind === 'file' ? bytes(files[`${dir}/${name}`]!) : 0, mtimeMs: kind === 'file' ? mtime() : 0, isLink: false,
    })) }
  })
  on('fs.read', (_, e) => {
    const { path, offset = 0 } = e as { path: string; offset?: number }
    const text = files[path]
    if (text === undefined) throw new Error('missing')
    return { value: new TextDecoder().decode(new TextEncoder().encode(text).slice(offset)) }
  })
  on('fs.exists', (_, e) => ({ value: String((e as { path?: string }).path) in files }))
  // `tail -c +N path`: the file from byte N on
  on('process.run', (_, e) => {
    const [cmd, , from, path] = (e as { argv: string[] }).argv
    const text = cmd === 'tail' ? files[path!] : undefined
    if (text === undefined) return { value: { exitCode: 1, stdout: '', stderr: 'missing', isStdoutTruncated: false, isStderrTruncated: false } }
    const rest = new TextDecoder().decode(new TextEncoder().encode(text).slice(Number(from!.slice(1)) - 1))
    return { value: { exitCode: 0, stdout: rest, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('a Codex run shows as a card with its tokens and its own subagent under it', async ($, on) => {
  const start = 1_000_000
  const clock = mock.clock(on, { now: start })
  const day = (() => { const d = new Date(start); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` })()
  const dir = `/home/u/.codex/sessions/${day}`
  const line = (o: unknown) => JSON.stringify(o) + '\n'
  const files: Record<string, string> = {}
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/u' : undefined }))
  on('fs.write', () => ({ value: undefined }))
  disk(on, files, () => clock.now())
  let finish: (() => void) | undefined
  on('tool.call', async (_, e) => {
    if ((e as { tool: string }).tool === 'Bash') await new Promise<void>(r => (finish = r))
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.session.start({ cwd: '/w/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Inventory', status: 'in_progress' }] } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'cd /w/proj && codex exec "list the training jobs"', description: 'Run the Codex inventory job', run_in_background: false } as never)
  await clock.advance(10)

  files[`${dir}/rollout-a-main.jsonl`] =
    line({ timestamp: iso(start + 500), type: 'session_meta', payload: { id: 'main-1', timestamp: iso(start + 500), cwd: '/w/proj', source: 'exec', originator: 'codex_exec', cli_version: '1' } }) +
    line({ timestamp: iso(start + 600), type: 'turn_context', payload: { model: 'gpt-5.5-codex' } }) +
    line({ timestamp: iso(start + 700), type: 'event_msg', payload: { type: 'task_started' } }) +
    line({ timestamp: iso(start + 900), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 90_000, cached_input_tokens: 0, output_tokens: 2_400, reasoning_output_tokens: 0, total_tokens: 92_400 },
      last_token_usage: { input_tokens: 40_000, cached_input_tokens: 0, output_tokens: 900, reasoning_output_tokens: 0, total_tokens: 40_900 },
      model_context_window: 272_000 } } })
  files[`${dir}/rollout-b-child.jsonl`] =
    line({ timestamp: iso(start + 800), type: 'session_meta', payload: { id: 'child-1', timestamp: iso(start + 800), cwd: '/w/proj', parent_thread_id: 'main-1', agent_nickname: 'Ada', agent_role: 'explorer',
      source: { subagent: { thread_spawn: { parent_thread_id: 'main-1', depth: 1 } } } } }) +
    line({ timestamp: iso(start + 950), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 10_000, output_tokens: 500, total_tokens: 10_500 },
      last_token_usage: { input_tokens: 8_000, output_tokens: 100, total_tokens: 8_100 } } } })
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 70 } })
  expect(await ui.find({ type: 'Text', text: /Run the Codex inventory job/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Codex · gpt-5\.5-codex · 42\.4k tokens/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Ada \(explorer\)$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /8\.5k tokens/ })).toBeTruthy()
  await ui.press({ key: 'btn-view-graph' })
  const svg = JSON.stringify(await ui.findAll({ type: 'Svg' }))
  expect(svg).toContain('Inventory')
  expect(svg).toContain('Run the Codex inventory job')
  expect(svg).toContain('Ada (explorer)')
  await ui.unmount()

  finish!()
  await call
  await clock.advance(1_000)
  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /Finished subagents \(1\)/ })).toBeTruthy()
  await done.unmount()
})

test('a Gemini run in the background finds its chat by project, and its subagent', async ($, on) => {
  const start = 2_000_000
  const clock = mock.clock(on, { now: start })
  const chats = '/home/u/.gemini/tmp/proj/chats'
  const line = (o: unknown) => JSON.stringify(o) + '\n'
  const files: Record<string, string> = { '/home/u/.gemini/tmp/proj/.project_root': '/w/proj\n', '/home/u/.gemini/tmp/other/.project_root': '/elsewhere' }
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/u' : undefined }))
  on('fs.write', () => ({ value: undefined }))
  disk(on, files, () => clock.now())
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }))

  await $.session.start({ cwd: '/w/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npx -y @google/gemini-cli -p "map the compute docs"', description: 'Run the Gemini inventory job', run_in_background: true } as never)
  files['/home/u/.gemini/tmp/other/chats/session-x-other.jsonl'] = line({ sessionId: 'nope', startTime: iso(start + 100), kind: 'main' })
  files[`${chats}/session-y-abcd1234.jsonl`] =
    line({ sessionId: 'abcd1234-main', projectHash: 'h', startTime: iso(start + 300), lastUpdated: iso(start + 300), kind: 'main' }) +
    line({ id: 'm1', timestamp: iso(start + 300), type: 'user', content: [{ text: 'map the compute docs' }] }) +
    line({ id: 'm2', timestamp: iso(start + 400), type: 'gemini', content: '', model: 'gemini-3-pro', toolCalls: [{ id: 'c1', name: 'invoke_agent', status: 'executing' }], tokens: { input: 30_000, output: 1_000, thoughts: 500, cached: 0, tool: 0, total: 31_500 } })
  files[`${chats}/abcd1234-main/sub-1.jsonl`] =
    line({ sessionId: 'sub-1', startTime: iso(start + 500), kind: 'subagent' }) +
    line({ id: 's1', type: 'user', content: 'Read the hardware docs' }) +
    line({ id: 's2', type: 'gemini', content: 'ok', tokens: { input: 5_000, output: 200, thoughts: 0 } })
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Gemini · gemini-3-pro · 31\.5k tokens/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Read the hardware docs$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /5\.2k tokens/ })).toBeTruthy()
  await ui.unmount()

  // the model answers, and the chat goes quiet: the run is done
  files[`${chats}/session-y-abcd1234.jsonl`] += line({ id: 'm3', type: 'gemini', content: 'Done.', tokens: { input: 36_000, output: 800, thoughts: 0 } })
  await clock.advance(3_000)
  await clock.advance(25_000)
  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /Finished subagents \(1\)/ })).toBeTruthy()
  await done.press({ key: 'btn-done:' })
  expect(await done.find({ type: 'Text', text: /38\.3k tokens/ })).toBeTruthy()
  await done.unmount()
})

test('only commands that run Codex or Gemini count as runs', async () => {
  expect(vendorOf('codex exec "x"')).toBe('codex')
  expect(vendorOf('cd a && npx @openai/codex@latest exec x')).toBe('codex')
  expect(vendorOf('gemini -p "x" --output-format json')).toBe('gemini')
  expect(vendorOf('npx -y @google/gemini-cli -p hi')).toBe('gemini')
  expect(vendorOf('codex --version')).toBeUndefined()
  expect(vendorOf('which gemini')).toBeUndefined()
  expect(vendorOf('grep -r codex src')).toBeUndefined()
  expect(vendorOf('ls ~/.codex/sessions')).toBeUndefined()
  expect(vendorOf('echo hi | codex exec -')).toBe('codex')
  expect(vendorOf('OPENAI_API_KEY=x timeout 600 codex exec y')).toBe('codex')
  expect(runDir('codex exec x', '/w/a', '/h')).toBe('/w/a')
  expect(runDir('cd ../b && codex exec x', '/w/a', '/h')).toBe('/w/b')
  expect(runDir('cd ~/proj && gemini -p x', '/w/a', '/h')).toBe('/h/proj')
  expect(runDir('codex exec -C /srv/app "x"', '/w/a', '/h')).toBe('/srv/app')
})

test('in the graph, finished subagents with no step fold away at the next message or plan', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'f1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.submit', (_, e) => e)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Read the docs page', subagentType: 'web-fetch' } as never)
  await $.turn.complete({ turnId: 't1', agentId: 'f1', reason: 'answer', answer: 'done' } as never)
  await clock.advance(1_000)

  const svgOf = async (ui: { findAll: (q: { type: 'Svg' }) => Promise<unknown> }) => JSON.stringify(await ui.findAll({ type: 'Svg' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'btn-view-graph' })
  // finished in this turn: still shown
  expect(await svgOf(ui)).toContain('Read the docs page')
  expect(await ui.find({ type: 'Text', text: /Finished subagents/ })).toBeFalsy()
  await ui.unmount()

  await $.prompt.submit({ text: 'next thing' } as never)
  await clock.advance(1_000)
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgOf(later)).not.toContain('Read the docs page')
  expect(await later.find({ type: 'Text', text: /Finished subagents \(1\)/ })).toBeTruthy()
  await later.unmount()
})

test('other sessions at work come first', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const snap = (id: string, folder: string, topic: string, busy: boolean) => ({
    sessionId: id, title: '', folder, topic,
    plan: [{ content: `${topic} step`, status: busy ? 'in_progress' : 'completed' }],
    history: [],
    agents: busy ? [{ id: `${id}-a`, description: 'Busy agent', type: 'Explore', prompt: 'x', status: 'running', startedAt: 4_990_000, toolCalls: 1 }] : [],
    updatedAt: 4_999_000,
  })
  const files: Record<string, unknown> = {
    'idle-1.json': snap('idle-1', 'a-app', 'Idle session', false),
    'busy-1.json': snap('busy-1', 'z-app', 'Busy session', true),
  }
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me-1' }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 4_999_000, isLink: false })) }))
  on('fs.read', (_, e) => ({ value: JSON.stringify(files[String((e as { path: string }).path).split('/').pop()!] ?? {}) }))

  await $.session.start({ cwd: '/Users/u/scratch', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(n => String((n as { text?: string }).text ?? ''))
  const busy = texts.findIndex(x => /Busy session/.test(x))
  const idle = texts.findIndex(x => /Idle session/.test(x))
  expect(busy).toBeGreaterThan(-1)
  expect(idle).toBeGreaterThan(busy)
  await ui.unmount()
})

test('a session at work glints round its frame, and one waiting on the user knocks', async ($, on) => {
  const clock = mock.clock(on, { now: 6_000_000 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', (_, e) => e)
  let answer: (() => void) | undefined
  on('tool.call', async (_, e) => {
    if ((e as { tool: string }).tool === 'AskUserQuestion') await new Promise<void>(r => (answer = r))
    return { result: { answers: {} } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Build', status: 'in_progress' }] } as never)
  await clock.advance(1_000)

  const svgs = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'btn-view-graph' })
    const json = JSON.stringify(await ui.findAll({ type: 'Svg' }))
    // the class on an element, not the style sheet's rule
    const svg = ['comet', 'knock'].filter(c => new RegExp(`class=\\\\+"${c}`).test(json)).join(' ')
    await ui.unmount()
    // the list (the terminal draws no graph) says it in words
    const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const waitingText = !!(await list.find({ type: 'Text', text: /waiting for you/ }))
    await list.unmount()
    return { svg, waitingText }
  }
  // a step in progress: the glint runs, nothing knocks
  let now1 = await svgs()
  expect(now1.svg).toContain('comet')
  expect(now1.svg).not.toContain('knock')

  // a question for the user: knocks once it has waited a moment
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(500)
  now1 = await svgs()
  expect(now1.svg).not.toContain('knock')
  await clock.advance(3_000)
  now1 = await svgs()
  expect(now1.svg).toContain('knock')
  expect(now1.svg).not.toContain('comet')
  expect(now1.waitingText).toBe(true)

  // answered: back to the glint
  answer!()
  await call
  await clock.advance(1_000)
  now1 = await svgs()
  expect(now1.svg).not.toContain('knock')
  expect(now1.svg).toContain('comet')

  // a turn that ends on a question for the user waits until their message
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x', ask: 'Go?', blocked: true } as never)
  await clock.advance(3_000)
  now1 = await svgs()
  expect(now1.svg).toContain('knock')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1_000)
  now1 = await svgs()
  expect(now1.svg).not.toContain('knock')
  expect(now1.svg).not.toContain('comet')
})
