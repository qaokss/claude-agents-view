import { expect, mock, test } from 'claude-code/testing'

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
