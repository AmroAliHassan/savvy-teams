import { test, expect, mock } from 'claude-code/testing'
import { tierOf, teamOf, rebuild, flowShapeProblem, agentsShapeProblem, splitSpBand, findSpBand, replaceAt, hasTopBand, deriveRows, layoutBand, runMs, unplannedRunning, fmtTime, parseTeams, ruleNeed, paneTree, routeATree } from '../hooks/register'
import type { SpFlow, SpRun } from '../types'

test('tiers follow the role; team names come from the teams setting', async () => {
  expect(tierOf('yt-showrunner')).toBe('heavy')
  expect(tierOf('cfo')).toBe('heavy')
  expect(tierOf('creative-director')).toBe('heavy')
  expect(tierOf('bd-design-director')).toBe('heavy')
  expect(tierOf('fact-checker')).toBe('careful')
  expect(tierOf('numbers-auditor')).toBe('careful')
  expect(tierOf('brand-guardian')).toBe('careful')
  expect(tierOf('design-critic')).toBe('careful')
  expect(tierOf('bd-design-checker')).toBe('careful')
  expect(tierOf('ui-room-seats')).toBe('careful')
  expect(tierOf('writer')).toBe('medium')
  expect(tierOf('Explore')).toBe('light')
  expect(tierOf('web-fetch')).toBe('light')
  expect(tierOf('general-purpose', 'claude-haiku-4-5-20251001')).toBe('light')
  expect(tierOf('yt-editor', 'claude-fable-5-1')).toBe('fable')
  const teams = parseTeams(TEAMS)
  expect(teamOf('yt-editor', teams)).toBe('Videos')
  expect(teamOf('ui-tao', teams)).toBe('Ideas')
  expect(teamOf('imagination-bench', teams)).toBe('Ideas')
  expect(teamOf('int-cad-lead', teams)).toBe('Interiors')
  expect(teamOf('bd-panel', teams)).toBe('Advisers')
  expect(teamOf('deck-designer', teams)).toBe('Agents')
  // No setting: every bar is titled Agents; a broken pair is skipped.
  expect(teamOf('yt-editor')).toBe('Agents')
  expect(parseTeams('([=Bad;^qa-=Checks;nothing')).toHaveLength(1)
})

// Team names as a person's settings would hold them (0.5.1: none are built in).
const TEAMS = '^yt-=Videos;^(ui-|imagination-bench$)=Ideas;^int-=Interiors;^bd-=Advisers'

test('an agent file decides the step rule: own copy, no tool, or add', async () => {
  const own = ['---', 'name: writer', 'tools: All tools', '---', 'Body.', '## Progress reporting', '- call `mcp__savvy-progress__step`'].join('\n')
  const locked = ['---', 'name: bd-panel', 'tools: Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch', '---', 'Advice only.'].join('\n')
  const checker = ['---', 'name: fact-checker', 'tools: Read, Write, ToolSearch, mcp__savvy-progress__step', '---', 'Check.'].join('\r\n')
  const open = ['---', 'name: helper', '---', 'Help.'].join('\n')
  expect(ruleNeed(own)).toBe('own')
  expect(ruleNeed(locked)).toBe('none')
  expect(ruleNeed(checker)).toBe('add')
  expect(ruleNeed(open)).toBe('add')
  expect(ruleNeed(null)).toBe('add')
})

test('an agent the noStepAgents setting names gets no step rule', { options: { noStepAgents: '^bd-' } }, async ($, on) => {
  const prompts: string[] = []
  on('agent.spawn', (_$, e) => { prompts.push(e.prompt); return { model: 'claude-sonnet-5-5', agentId: 'agent-3' } })
  await $.agent.spawn({ prompt: 'Read the room.', description: 'Advice read', subagentType: 'bd-panel' })
  expect(prompts[0]).toBe('Read the room.')
})

// 0.5.3 (review F7): the two stubs are real tests now.
test('a run left out of the lead plan does not change the total', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  const reports: Array<Record<string, unknown>> = []
  on('tool.call', { tool: 'mcp__savvy-progress__progress' }, (_$, e) => { reports.push(e as unknown as Record<string, unknown>); return { result: 'ok' } })
  // The lead's own bar is live, with its two planned tasks.
  on('state.get', (_$, e) => {
    if (`${e.plugin}.${e.key}` === 'savvy-progress.flow') return { value: { value: job({ title: 'Job', total: 2, tasks: [{ title: 'A', tier: 'medium' }, { title: 'B', tier: 'medium' }] }), version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'adhoc-1' }))
  await $.agent.spawn({ prompt: 'Look it up.', description: 'Ad-hoc check', subagentType: 'Explore' })
  await clock.advance(5000)
  expect(reports.filter(r => Array.isArray(r.tasks))).toHaveLength(0)
  expect(reports.filter(r => r.total !== undefined)).toHaveLength(0)
})

test('every session gets the lead rule as the last section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(sections.at(-1)?.id).toBe('savvy-teams:lead')
  expect(sections.at(-1)?.text).toContain('mcp__savvy-progress__progress')
})

test('a spawn gets the step rule and opens a bar for its team', { options: { teams: TEAMS } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const prompts: string[] = []
  const reports: Array<Record<string, unknown>> = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
  })
  on('tool.call', { tool: 'mcp__savvy-progress__progress' }, (_$, e) => {
    reports.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })

  await $.agent.spawn({ prompt: 'Write the hook.', description: 'Write hook r1', subagentType: 'yt-editor' })
  // The auto-tracker waits 4 s for a lead that plans in the same message.
  expect(reports).toHaveLength(0)
  await clock.advance(5000)

  expect(prompts[0]).toContain('## Progress reporting')
  expect(prompts[0]).toContain('mcp__savvy-progress__step')
  expect(prompts[0]).toContain('never in a message of its own')
  expect(prompts[0]).not.toContain('Before your final answer')
  expect(reports[0]).toMatchObject({ title: 'Videos', phase: 'delegate', tasks: [{ title: 'Write hook r1', tier: 'medium' }] })
})

test('a prompt that already has the step rule is left alone', async ($, on) => {
  const prompts: string[] = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: 'claude-sonnet-5-5', agentId: 'agent-2' }
  })
  await $.agent.spawn({ prompt: 'Call mcp__savvy-progress__step as you go.', description: 'x', subagentType: 'general-purpose' })
  expect(prompts[0]).toBe('Call mcp__savvy-progress__step as you go.')
})

test('/progress-bar rebuilds a closed bar from the runs', async () => {
  const runs = [
    { type: 'general-purpose', description: 'Count agent files', model: 'claude-haiku-4-5', status: 'done' },
    { type: 'yt-editor', description: 'Write hook', model: 'claude-sonnet-5-5', status: 'running' },
    { type: 'yt-editor', description: 'Write hook', model: 'claude-sonnet-5-5', status: 'done' },
  ]
  expect(rebuild(runs)).toMatchObject({
    title: 'Agents',
    phase: 'delegate',
    total: 2,
    done: 2,
    tasks: [{ title: 'Count agent files', tier: 'light' }, { title: 'Write hook', tier: 'medium' }],
  })
  expect(rebuild([])).toBe(null)
})

test('/progress-bar says so when there is nothing to bring back', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'session-1' }))
  const { text } = await $.command.run({ command: 'progress-bar', args: '' })
  expect(text).toContain('no progress bar of this session')
})

// ---------------------------------------------------------------------------
// 0.4.0: the checklist band. Same job as the mock-up (savvy-bar-routes.html).

const T = 1_000_000
const job = (over: Partial<SpFlow> = {}): SpFlow => ({
  title: 'Sales book v2',
  total: 5,
  done: 2,
  running: 0,
  phase: 'review',
  isFinished: false,
  tasks: [
    { title: 'Research benchmarks', tier: 'medium', after: [] },
    { title: 'Outline and copy', tier: 'medium', after: [1] },
    { title: 'Layout build', tier: 'medium', after: [2] },
    { title: 'Fact check', tier: 'careful', after: [2] },
    { title: 'Brand check', tier: 'careful', after: [3] },
  ],
  ...over,
})
const runs: SpRun[] = [
  { id: 'a1', agentId: 'a1', type: 'researcher', description: 'Research benchmarks', status: 'done', startedAt: T, endedAt: T + 372_000 },
  { id: 'a2', agentId: 'a2', type: 'writer', description: 'Outline and copy', status: 'done', startedAt: T + 400_000, endedAt: T + 980_000 },
  { id: 'a3', agentId: 'a3', type: 'book-designer', description: 'Layout build', status: 'running', startedAt: T + 1_000_000, stepDone: 3, stepTotal: 6 },
  { id: 'a4', agentId: 'a4', type: 'fact-checker', description: 'Fact check', status: 'done', startedAt: T + 1_000_000, endedAt: T + 1_202_000 },
]
const AT = T + 1_245_000
const joined = (segs: { text: string }[]) => segs.map(s => s.text).join('')
const spRow = { type: 'Box', props: { flexDirection: 'row' }, children: [{ type: 'Button', props: { key: 'savvy-dismiss', label: '✕' } }] }

test('the 1.2.1 state shape passes the guard; anything else names the problem', async () => {
  expect(flowShapeProblem(job())).toBe('')
  expect(agentsShapeProblem(runs)).toBe('')
  expect(flowShapeProblem({ ...job(), phase: 'shipping' })).toContain('phase')
  expect(flowShapeProblem({ ...job(), tasks: [{ title: 'x' }] })).toContain('planned task')
  expect(flowShapeProblem(null)).toContain('not an object')
  expect(agentsShapeProblem([{ id: 'x', type: 'writer', description: 'd', status: 'paused', startedAt: 1 }])).toContain('status')
})

test('the guard finds savvy-progress 1.2.1 row and keeps the bands beneath it', async () => {
  const below = { type: 'Text', children: ['another mod'] }
  expect(splitSpBand({ type: 'Box', props: { flexDirection: 'column' }, part: { plugin: 'savvy-progress' }, children: [spRow, below] })).toEqual({ ok: true, below })
  expect(splitSpBand({ type: 'Box', props: { flexDirection: 'column' }, children: [spRow, null] })).toEqual({ ok: true, below: null })
})

test('a mod that wraps savvy-progress\'s band keeps its rows; the checklist takes the band\'s place', async () => {
  const strip = { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', children: ['Night shift'] }] }
  const sp = { type: 'Box', props: { flexDirection: 'column' }, part: { plugin: 'savvy-progress' }, children: [spRow] }
  const wrapped = { type: 'Box', props: { flexDirection: 'column' }, part: { plugin: 'night-shift' }, children: [strip, sp] }
  expect(splitSpBand(wrapped).ok).toBe(false)
  const found = findSpBand(wrapped)
  expect(found?.path).toEqual([1])
  const swapped = replaceAt(wrapped, found!.path, { type: 'Text', children: ['LANES'] }) as { children: unknown[] }
  expect(swapped.children[0]).toBe(strip)
  expect(swapped.children[1]).toEqual({ type: 'Text', children: ['LANES'] })
  expect(findSpBand({ type: 'Box', props: { flexDirection: 'column' }, children: [strip] })).toBeNull()
})

test('night-shift\'s strip is known as a band for the top; other bands are not', async () => {
  const strip = { type: 'Box', props: { key: 'night-shift-strip', flexDirection: 'column' }, children: [] }
  expect(hasTopBand({ type: 'Box', props: { flexDirection: 'column' }, children: [strip, { type: 'Text', children: ['x'] }] })).toBe(true)
  expect(hasTopBand({ type: 'Box', props: { key: 'skins-band' }, children: [] })).toBe(false)
})

test('the guard refuses any other band shape, so savvy-progress draws its own bar', async () => {
  expect(splitSpBand({ type: 'engine', ref: 0 }).ok).toBe(false)
  expect(splitSpBand({ type: 'Box', props: { flexDirection: 'row' }, children: [spRow] }).ok).toBe(false)
  expect(splitSpBand({ type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', children: ['no row'] }] }).ok).toBe(false)
  expect(splitSpBand({ type: 'Box', props: { flexDirection: 'column' }, part: { plugin: 'skins' }, children: [spRow] }).ok).toBe(false)
  expect(splitSpBand(undefined).ok).toBe(false)
})

test('rows: accepted, running, in review and waiting, as in the mock-up', async () => {
  const rows = deriveRows(job(), runs, {}, AT)
  expect(rows.map(r => r.state)).toEqual(['done', 'done', 'running', 'review', 'waiting'])
  expect(rows[4].waitsOn).toEqual([3])
  expect(rows[2]).toMatchObject({ agent: 'book-designer', stepDone: 3, stepTotal: 6 })
  expect(rows[4]).toMatchObject({ agent: 'careful', isAgentKnown: false, ms: null })
})

test('the lead count decides accepted vs in review, in answer order', async () => {
  const rows = deriveRows(job({ done: 1 }), runs, {}, AT)
  expect(rows.map(r => r.state).slice(0, 4)).toEqual(['done', 'review', 'running', 'review'])
})

test('a failed dependency blocks the task that waits on it', async () => {
  const failed = runs.map(a => (a.id === 'a3' ? { ...a, status: 'failed' as const, endedAt: T + 1_100_000 } : a))
  const rows = deriveRows(job(), failed, {}, AT)
  expect(rows[2].state).toBe('failed')
  expect(rows[4]).toMatchObject({ state: 'blocked', waitsOn: [3] })
})

test('a SendMessage resume does not count the idle gap', async () => {
  // 100 s in the first round, idle, then 45 s into the second round.
  expect(runMs(runs[2], { activeMs: 100_000, since: AT - 45_000, rounds: 2, nested: false }, AT)).toBe(145_000)
  // No clock (spawned before the plugin loaded): savvy-progress's wall time.
  expect(runMs(runs[2], undefined, AT)).toBe(245_000)
})

test('nested runs and unplanned runs stay off the task rows', async () => {
  const extra: SpRun[] = [
    ...runs,
    { id: 'n1', agentId: 'n1', type: 'Explore', description: 'Fact check', status: 'running', startedAt: AT - 1000 },
    { id: 'u1', agentId: 'u1', type: 'Explore', description: 'Quick look', status: 'running', startedAt: AT - 1000 },
  ]
  const clocks = { n1: { activeMs: 0, since: AT - 1000, rounds: 1, nested: true } }
  expect(deriveRows(job(), extra, clocks, AT)[3].state).toBe('review')
  expect(unplannedRunning(job(), extra, clocks)).toBe(1)
})

test('the band reads like the mock-up: header plus one row per task, no percent', async () => {
  const band = layoutBand(job(), deriveRows(job(), runs, {}, AT), { cols: 60, maxLines: 6, elapsedMs: 1_421_000, unplanned: 0 })
  expect(joined(band.header)).toContain('Sales book v2')
  expect(joined(band.header)).toContain('review · 2/5 accepted · 23:41')
  expect(band.lines.map(joined)).toEqual([
    '✓ 1 Research benchmarks  researcher     done        6:12',
    '✓ 2 Outline and copy     writer         done        9:40',
    '● 3 Layout build         book-designer  ━━━─── 3/6  4:05',
    '◆ 4 Fact check           fact-checker   to review   3:22',
    '○ 5 Brand check          careful        after 3        –',
  ])
  expect([joined(band.header), ...band.lines.map(joined)].some(l => l.includes('%'))).toBe(false)
})

test('past 6 tasks the done rows fold and the band stays at 7 lines', async () => {
  const big = job({ done: 4, tasks: Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i + 1}`, tier: 'medium', after: [] })) })
  const bigRuns: SpRun[] = Array.from({ length: 7 }, (_, i) => ({
    id: `b${i}`,
    agentId: `b${i}`,
    type: 'writer',
    description: `Task ${i + 1}`,
    status: i < 5 ? ('done' as const) : ('running' as const),
    startedAt: T,
    ...(i < 5 ? { endedAt: T + 60_000 + i } : {}),
  }))
  const band = layoutBand(big, deriveRows(big, bigRuns, {}, AT), { cols: 60, maxLines: 6, elapsedMs: 0, unplanned: 0 })
  expect(band.lines.length).toBeLessThanOrEqual(6)
  expect(joined(band.lines[0])).toContain('4 done')
  expect(band.lines.map(joined).some(l => l.includes('Task 6'))).toBe(true)
  expect(joined(band.lines[band.lines.length - 1])).toContain('more')
})

test('times read m:ss, then h:mm:ss', async () => {
  expect(fmtTime(372_000)).toBe('6:12')
  expect(fmtTime(3_723_000)).toBe('1:02:03')
})

test('/progress-bar check answers in plain words', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1000 })
  const { text: out } = await $.command.run({ command: 'progress-bar', args: 'check' })
  expect(out).toContain('Verdict')
  expect(out).toContain('Hook order')
})

// The guard, end to end: here the band beneath is drawn by the test, not by
// savvy-progress, so the hook order check fails and the band must pass through
// untouched (no checklist, no second bar).
test('a band savvy-progress did not draw beneath us passes through untouched', async ($, on) => {
  mock.clock(on, { now: AT })
  on('state.get', (_$, e) => {
    const name = `${e.plugin}.${e.key}`
    if (name === 'savvy-progress.flow') return { value: { value: job(), version: 1 } }
    if (name === 'savvy-progress.agents') return { value: { value: runs, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('ui.render', ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [Box({ flexDirection: 'row', children: [Text({ children: ['OLD BAR'] }), Button({ key: 'savvy-dismiss', label: '✕', plain: true, onPress: () => undefined })] })],
    })
  })
  const ui = await $.ui.mount({
    plugin: 'savvy-teams',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
  } as never)
  expect((await ui.find({ type: 'Text', text: /OLD BAR/ }))?.text).toBe('OLD BAR')
  expect(await ui.find({ type: 'Text', text: /accepted/ })).toBeFalsy()
  await ui.unmount()
  const { text: out } = await $.command.run({ command: 'progress-bar', args: 'check' })
  expect(out).toContain('old savvy-progress bar is showing')
})

// 0.5.0 Lanes: plain constructors stand in for a graphical surface's elements.
type Node = { type: string; props: Record<string, unknown>; children: unknown[] }
const els = {
  Box: (p: Record<string, unknown>) => ({ type: 'Box', props: p, children: (p.children as unknown[]) ?? [] }),
  Text: (p: Record<string, unknown>) => ({ type: 'Text', props: p, children: (p.children as unknown[]) ?? [] }),
  Svg: (p: { source: string; alt: string }) => ({ type: 'Svg', props: p, children: [] }),
}
const walk = (n: unknown, out: Node[] = []): Node[] => {
  if (n && typeof n === 'object' && 'type' in (n as Node)) { out.push(n as Node); for (const c of (n as Node).children) walk(c, out) }
  return out
}
const words = (n: unknown) => walk(n).filter(x => x.type === 'Text').flatMap(x => x.children.filter(c => typeof c === 'string')).join(' | ')

test('the Agents panel is black and white: plain cards, coral only for a failure', async () => {
  const Button = (p: Record<string, unknown>) => ({ type: 'Button', props: p, children: [] })
  const rich = runs.map((a, i) => ({ ...a, model: 'claude-sonnet-5-5', tokens: 100_000 * (i + 1), costUsd: 1.5 * (i + 1), contextTokens: 60_000, contextMax: 200_000 }))
  const failed = [...rich, { ...rich[0], id: 'f1', agentId: 'f1', description: 'Broken run', status: 'failed' as const, endedAt: AT }]
  let toggled = 0
  const tree = paneTree({ ...els, Button }, failed, job(), AT, { card: '#2A2A28', line: '#3A3A37', ink: '#F2F0EB', dim: '#9B988F', track: '#454541' }, 420, true, () => { toggled++ })
  const svgs = walk(tree).filter(x => x.type === 'Svg').map(x => String(x.props.source))
  expect(svgs.join('')).not.toContain('linearGradient')
  expect(svgs.filter(s => s.includes('#E63946'))).toHaveLength(1)
  expect(svgs[0]).toContain('Cost')
  const toggle = walk(tree).find(x => x.type === 'Button')
  expect(String(toggle?.props.label)).toContain('Finished')
  ;(toggle?.props.onPress as () => void)()
  expect(toggled).toBe(1)
  // Planned tasks not started show as dashed cards.
  expect(walk(tree).filter(x => x.type === 'Svg').some(x => String(x.props.alt).includes('planned'))).toBe(true)
  // After a restart: the plan without its runs still draws the black-and-white panel, accepted tasks ticked.
  const restored = paneTree({ ...els, Button }, [], job({ done: 5 }), AT, { card: '', line: '', ink: '', dim: '', track: '' }, 420, true, () => undefined)
  expect(walk(restored).filter(x => x.type === 'Svg').some(x => String(x.props.alt).includes('accepted'))).toBe(true)
  expect(words(restored)).toContain('No agent has run in this session yet')
})

test('Route A: a header drawing with Agents and ✕ beside it, one list card, no loose text', async () => {
  const btn = (key: string) => ({ type: 'Button', props: { key, variant: 'secondary' }, children: [] })
  const tree = routeATree(els, job(), deriveRows(job(), runs, {}, AT), { maxLines: 6, elapsedMs: 7_080_000, unplanned: 0, cols: 110, bodyCols: 117 }, btn('a'), btn('x'), false)
  const nodes = walk(tree)
  expect(nodes.filter(x => x.type === 'Text')).toHaveLength(0)
  const svgs = nodes.filter(x => x.type === 'Svg' && x.props.alt !== 'space')
  expect(svgs).toHaveLength(2)
  const [head, card] = svgs.map(x => String(x.props.source))
  expect(head).toContain('Sales book v2')
  expect(head).toContain('2 of 5 accepted')
  expect(head).toContain('1h 58m')
  expect(card).toContain('Layout build')
  expect(card).toContain('3/6')
  expect(card).toContain('ready for review')
  // Times are minutes only: no m:ss anywhere in the drawings.
  expect(/\d+:\d\d/.test(head + card)).toBe(false)
  // The current-step relay runs on a 6 s loop, so a once-a-minute redraw never shows.
  expect(card).toContain('dur="6s"')
  expect(nodes.filter(x => x.type === 'Button').map(x => x.props.variant)).toEqual(['secondary', 'secondary'])
})

test('Route A: a job with every task accepted reads Done, with no live rows', async () => {
  const fin = { ...job({ done: 5 }) }
  const doneRuns = runs.map(a => ({ ...a, status: 'done' as const, endedAt: a.endedAt ?? AT }))
  const tree = routeATree(els, fin, deriveRows(fin, doneRuns, {}, AT), { maxLines: 6, elapsedMs: 0, unplanned: 0, cols: 110, bodyCols: 117 }, null, null, true)
  const svgs = walk(tree).filter(x => x.type === 'Svg' && x.props.alt !== 'space').map(x => String(x.props.source))
  expect(svgs[0]).toContain('Done')
  expect(svgs[0]).toContain('5 of 5 accepted')
  expect(svgs[1]).toContain('5 accepted')
  expect(svgs[1]).not.toContain('ready for review')
})

test('the desktop accepts Route A', async ($, on) => {
  mock.clock(on, { now: AT })
  on('ui.render', ($, e) => {
    const ui = $.ui.resolve(e) as never as Record<string, (p: unknown) => unknown>
    const b = (key: string, label: string) => ui.Button({ key, label, variant: 'secondary', onPress: () => undefined })
    return ui.Box({ flexDirection: 'column', children: [
      ui.Box({ flexDirection: 'row', children: [ui.Button({ key: 'savvy-dismiss', label: '✕', plain: true, onPress: () => undefined })] }),
      routeATree({ Box: ui.Box, Text: ui.Text, Svg: ui.Svg } as never, job(), deriveRows(job(), runs, {}, AT), { maxLines: 6, elapsedMs: 1_421_000, unplanned: 0, cols: 110, bodyCols: 117 }, b('a', 'Agents'), b('x', '✕'), false),
    ] })
  })
  const ui = await $.ui.mount({ plugin: 'savvy-teams', component: 'AbovePrompt', requestId: 'band', surface: 'desktop', props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 117, scroll: { offset: 0, bodyRows: 12 }, view: {} } } as never)
  expect(Boolean(await ui.find({ type: 'Button', text: /Agents/ }))).toBe(true)
  await ui.unmount()
})
