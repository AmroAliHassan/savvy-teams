import type { Register, EngineInterface } from 'claude-code'
import type { AutoFlow, JobClock, RunClock, SavedBar, SavedFlow, SpFlow, SpRun } from '../types'

// Companion to savvy-progress. That mod draws the bar only when the lead calls
// its `progress` tool or a `savvy-*` agent starts, and keeps it in session
// memory only. Our agents are not savvy-*, so this plugin carries the rules
// into every session, saves each session's bar so /resume and restarts bring
// it back, and fills in for a lead that forgets to report.
//
// 0.4.0 adds the checklist band: one row per planned task (state, task, agent,
// step bar, active time) drawn in theme colours in place of savvy-progress's
// row. It draws only when a run-time guard confirms savvy-progress 1.2.1's state
// shape and that this hook sits outside savvy-progress's band and can replace
// its row; otherwise savvy-progress's own bar shows untouched.

const AUTO = { plugin: 'savvy-teams', key: 'auto' } as const
const LAST = { plugin: 'savvy-teams', key: 'last' } as const
const HIDDEN = { plugin: 'savvy-teams', key: 'hidden' } as const
const JOB = { plugin: 'savvy-teams', key: 'job' } as const
const TICK = { plugin: 'savvy-teams', key: 'tick' } as const
const CLOCK = { plugin: 'savvy-teams', key: 'clock' } as const
const FLOW = { plugin: 'savvy-progress', key: 'flow' } as const
const AGENTS = { plugin: 'savvy-progress', key: 'agents' } as const
const SP_NOW = { plugin: 'savvy-progress', key: 'now' } as const
const COMMAND = 'progress-bar'
const PROGRESS = 'mcp__savvy-progress__progress'
const STEP = 'mcp__savvy-progress__step'
const BAR_PREFIX = 'bar:'
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
// Lets a lead that plans in the same message as its spawns land the plan first.
const AUTO_DELAY_MS = 4000
// A bar left open with no agent running ticks once a minute after this long, not every second.
const IDLE_SLOW_MS = 10 * 60 * 1000
const RESTORE_DELAY_MS = 1500
// savvy-progress's ✕ Button key: the fingerprint of its own row in the band.
const SP_DISMISS_KEY = 'savvy-dismiss'
const CLOSE_KEY = 'savvy-teams-close'

const LEAD_RULE = `# Progress bar (Savvy Progress mod)
This section is for the main session (the lead) only; a subagent ignores it. Our agents are not named \`savvy-*\`, so the bar above the chat box shows only if the lead reports progress.
- Whenever you delegate 2 or more subagent tasks in one job, call \`${PROGRESS}\` with \`title\` (a few words), \`phase: "delegate"\` and \`tasks\` (each with \`title\`, \`tier\`, and \`after\` for dependencies), in its own message BEFORE the Agent calls.
- Use each task \`title\` word for word as the Agent \`description\`. Keep it short and unique. Keep the bar's \`title\` the same for the whole job: a changed title starts a new bar at 0.
- A fix round sent with SendMessage is the same task, not a new one. Give a new planned task a fresh Agent call with its own description. A retake ("X r2") or an ad-hoc check that should count: re-send \`tasks\` with it added.
- After reviewing and accepting each task, call it again with \`done\` = number of planned tasks accepted (never more than the planned total). Switch \`phase\` to \`review\` during checks and \`close\` at the end.
- Finish with \`finished: true\`. A new \`title\` starts a new bar.
- Tier map: \`fable\` = runs on Fable; \`heavy\` = leads and directors (showrunner, editor-in-chief, CFO, creative director, design director, program lead); \`careful\` = independent checkers (fact-checker, numbers auditor, brand guardian, design critic and design checker, tech QA, red team, legal-ethics, room seats, decision keeper); \`medium\` = builders and writers (most members); \`light\` = quick lookups, Explore, web-fetch, small file jobs.
- The savvy-teams plugin saves this session's bar and brings it back after /resume; if you forget to plan, it adds each run by itself, but only your calls give planned rows, tiers and accepted counts.`

const WORKER_RULE = `

## Progress reporting
- Right after reading the brief, call \`${STEP}\` with \`total\` (your plan in 3 to 8 steps), \`done: 0\` and \`note\` (the first step, a few words), in the same message as your first real tool call.
- After each step, send the next call (new \`done\`, next \`note\`) in the same message as your next real tool call, never in a message of its own. No final call: your row closes when you answer.
- If the tool isn't available, skip this rule.`

type Task = { title: string; tier: string; after?: number[] }

const bare = (type: string): string => type.replace(/^[^:]*:/, '').toLowerCase()
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Team names for auto-tracked bars, from the `teams` setting: `regex=Name`
 * pairs split by `;` (`^yt-=Videos;^qa-=Checks`). A pair that does not parse
 * is skipped; with none, every bar is titled "Agents".
 */
export const parseTeams = (spec: string | undefined): Array<[RegExp, string]> =>
  String(spec ?? '')
    .split(';')
    .map(pair => pair.trim())
    .flatMap((pair): Array<[RegExp, string]> => {
      const at = pair.lastIndexOf('=')
      if (at <= 0 || !pair.slice(at + 1).trim()) return []
      try {
        return [[new RegExp(pair.slice(0, at).trim()), pair.slice(at + 1).trim()]]
      } catch {
        return []
      }
    })
export const teamOf = (type: string, teams: Array<[RegExp, string]> = []): string => teams.find(([re]) => re.test(bare(type)))?.[1] ?? 'Agents'

/**
 * What an agent's own file says about the step rule: `own` when its prompt
 * already names the step tool, `none` when its `tools:` allow-list leaves the
 * tool out (it could not call it), else `add`. No file (a built-in or a
 * plugin's agent): `add`.
 */
export const ruleNeed = (file: string | null): 'own' | 'none' | 'add' => {
  if (!file) return 'add'
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file)
  const head = fm ? fm[1] : ''
  const body = fm ? file.slice(fm[0].length) : file
  if (body.includes(STEP)) return 'own'
  const tools = /^tools:\s*(.*)$/m.exec(head)?.[1]?.trim()
  if (tools && tools !== '*' && !tools.includes(STEP) && !/\bAll tools\b/i.test(tools)) return 'none'
  return 'add'
}


// Each agent type's file, read once per load: does it carry the rule, or lack the tool?
const needs = new Map<string, 'own' | 'none' | 'add'>()
async function needOf($: EngineInterface, type: string): Promise<'own' | 'none' | 'add'> {
  if (type.includes(':')) return 'add'
  const known = needs.get(type)
  if (known) return known
  const name = type.replace(/[^\w.-]/g, '')
  const claudeDir = $.plugin.root.split(/[\\/]plugins[\\/]/)[0]
  let need: 'own' | 'none' | 'add' = 'add'
  let projectDir = ''
  try {
    projectDir = await $.session.root()
  } catch {
    // A host without a project root: the user's own agents only.
  }
  const places = [...(projectDir ? [`${projectDir}/.claude/agents/${name}.md`] : []), `${claudeDir}/agents/${name}.md`]
  for (const path of places) {
    try {
      need = ruleNeed(await $.fs.read(path))
      break
    } catch {
      // Not there: try the next place.
    }
  }
  needs.set(type, need)
  return need
}

export const tierOf = (type: string, model = ''): string => {
  const t = bare(type)
  if (/fable/i.test(model)) return 'fable'
  if (/(factchecker|fact-checker|auditor|guardian|tech-qa|red-team|ethics|copy-reviewer|legal-reviewer|design-critic|design-checker|room-seats|decision-keeper)/.test(t)) return 'careful'
  if (/(showrunner|editor-in-chief|cfo|creative-director|design-director|program-director|context-lead)/.test(t)) return 'heavy'
  if (/^(explore|claude-code-guide|statusline-setup|web-fetch)$/.test(t) || /haiku/i.test(model)) return 'light'
  return 'medium'
}

// ---------------------------------------------------------------------------
// The checklist band: pure parts, exported for the tests.

const PHASES = ['plan', 'design', 'delegate', 'review', 'close']
const STATUSES = ['running', 'done', 'failed']
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why `v` is not savvy-progress 1.2.1's `flow`, in plain words; '' when it is. */
export const flowShapeProblem = (v: unknown): string => {
  if (!isObj(v)) return 'flow is not an object'
  if (!isStr(v.title)) return 'flow.title is not text'
  for (const k of ['total', 'done', 'running']) if (!isNum(v[k])) return `flow.${k} is not a number`
  if (!isStr(v.phase) || !PHASES.includes(v.phase)) return 'flow.phase is not a known phase'
  if (typeof v.isFinished !== 'boolean') return 'flow.isFinished is not true or false'
  if (!Array.isArray(v.tasks)) return 'flow.tasks is not a list'
  for (const t of v.tasks) {
    if (!isObj(t) || !isStr(t.title) || !isStr(t.tier) || !Array.isArray(t.after) || !t.after.every(isNum)) return 'a planned task lacks title, tier or after'
  }
  return ''
}

/** Why `v` is not savvy-progress 1.2.1's `agents` list, in plain words; '' when it is. */
export const agentsShapeProblem = (v: unknown): string => {
  if (!Array.isArray(v)) return 'agents is not a list'
  for (const a of v) {
    if (!isObj(a)) return 'an agent row is not an object'
    if (!isStr(a.id) || !isStr(a.type) || !isStr(a.description)) return 'an agent row lacks id, type or description'
    if (a.agentId !== undefined && !isStr(a.agentId)) return 'an agent row has a bad agentId'
    if (!isStr(a.status) || !STATUSES.includes(a.status)) return 'an agent row has an unknown status'
    if (!isNum(a.startedAt)) return 'an agent row lacks startedAt'
    for (const k of ['endedAt', 'stepDone', 'stepTotal']) if (a[k] !== undefined && !isNum(a[k])) return `an agent row has a bad ${k}`
  }
  return ''
}

type Dict = { type?: unknown; props?: Record<string, unknown>; children?: unknown[]; part?: { plugin?: unknown } }
const isSp = (name: unknown): boolean => isStr(name) && /^savvy-progress(@|$)/.test(name)

const hasButton = (n: unknown, key: string, depth = 0): boolean => {
  if (depth > 6 || !n || typeof n !== 'object') return false
  const d = n as Dict
  if (d.type === 'Button' && d.props?.key === key) return true
  return Array.isArray(d.children) && d.children.some(c => hasButton(c, key, depth + 1))
}

export type Split = { ok: true; below: unknown | null } | { ok: false; reason: string }

/**
 * savvy-progress 1.2.1 answers the band with a column Box: its own row (holding
 * its ✕, key 'savvy-dismiss'), then the other mods' bands, if any. Returns what
 * lies beneath its row, or why the answer is not that shape.
 */
export const splitSpBand = (drawn: unknown): Split => {
  if (!drawn || typeof drawn !== 'object') return { ok: false, reason: 'the band answer was empty' }
  const d = drawn as Dict
  if (d.type !== 'Box') return { ok: false, reason: `the band answer is a ${String(d.type)}, not savvy-progress's Box` }
  if (d.part && d.part.plugin !== undefined && !isSp(d.part.plugin)) return { ok: false, reason: `the band answer is ${String(d.part.plugin)}'s, not savvy-progress's` }
  if (d.props?.flexDirection !== 'column') return { ok: false, reason: 'savvy-progress\'s band is not the 1.2.1 column layout' }
  const kids = (Array.isArray(d.children) ? d.children : []).filter(c => c !== null && c !== undefined && c !== false && c !== '')
  if (kids.length < 1 || kids.length > 2) return { ok: false, reason: `savvy-progress's band has ${kids.length} parts, 1.2.1 has 1 or 2` }
  if (!hasButton(kids[0], SP_DISMISS_KEY)) return { ok: false, reason: 'savvy-progress\'s own row (its ✕) was not found' }
  return { ok: true, below: kids[1] ?? null }
}

export type RowState = 'done' | 'review' | 'running' | 'next' | 'waiting' | 'failed' | 'blocked' | 'skipped'

export type Row = {
  n: number
  title: string
  /** The agent type of the task's latest run, else the planned tier. */
  agent: string
  isAgentKnown: boolean
  state: RowState
  /** Task numbers it still waits on, or the failed one that blocks it. */
  waitsOn: number[]
  stepDone?: number
  stepTotal?: number
  /** Active time over all its runs; null before it ran. */
  ms: number | null
}

/** Active time of one run: its clock's closed spans plus the open one, else its wall time. */
export const runMs = (a: SpRun, clock: RunClock | undefined, at: number): number => {
  if (clock) return clock.activeMs + (clock.since !== null ? Math.max(0, at - clock.since) : 0)
  return Math.max(0, (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt)
}

/**
 * One row per planned task. The lead's `done` is a count, not a list: the first
 * `done` tasks to answer (in answer order) are accepted, the other answered ones
 * wait for review. A count above what was seen to answer accepts the first
 * unrun tasks in plan order (work done before a reload, or by the lead itself).
 */
export const deriveRows = (flow: SpFlow, runs: readonly SpRun[], clocks: Readonly<Record<string, RunClock>>, at: number): Row[] => {
  const top = runs.filter(a => !(a.agentId && clocks[a.agentId]?.nested))
  const byTask = flow.tasks.map(t => top.filter(a => norm(a.description) === norm(t.title)))
  const last = (i: number): SpRun | undefined => byTask[i]?.[byTask[i].length - 1]

  const answered = byTask
    .map((_, i) => ({ i, run: last(i) }))
    .filter(x => x.run?.status === 'done')
    .sort((x, y) => (x.run?.endedAt ?? 0) - (y.run?.endedAt ?? 0))
  const accepted = new Set<number>()
  const quota = flow.isFinished ? answered.length : Math.max(0, Math.round(flow.done))
  answered.slice(0, quota).forEach(x => accepted.add(x.i))
  let extra = flow.isFinished ? 0 : Math.max(0, Math.round(flow.done) - answered.length)
  for (let i = 0; i < byTask.length && extra > 0; i++) {
    if (!byTask[i].length) {
      accepted.add(i)
      extra--
    }
  }

  const base: RowState[] = flow.tasks.map((_, i) => {
    const run = last(i)
    if (accepted.has(i)) return 'done'
    if (run) return run.status === 'running' ? 'running' : run.status === 'failed' ? 'failed' : 'review'
    return flow.isFinished ? 'skipped' : 'next'
  })

  return flow.tasks.map((t, i) => {
    const run = last(i)
    const deps = [...new Set(t.after)].filter(n => Number.isInteger(n) && n >= 1 && n <= flow.tasks.length && n !== i + 1)
    let state = base[i]
    let waitsOn: number[] = []
    if (state === 'next') {
      const failed = deps.filter(n => base[n - 1] === 'failed' || base[n - 1] === 'blocked')
      const open = deps.filter(n => base[n - 1] !== 'done')
      if (failed.length) {
        state = 'blocked'
        waitsOn = failed
      } else if (open.length) {
        state = 'waiting'
        waitsOn = open
      }
    }
    const ms = byTask[i].length ? byTask[i].reduce((s, a) => s + runMs(a, a.agentId ? clocks[a.agentId] : undefined, at), 0) : null
    return {
      n: i + 1,
      title: t.title,
      agent: run ? bare(run.type) : t.tier,
      isAgentKnown: !!run,
      state,
      waitsOn,
      ...(run && isNum(run.stepTotal) && run.stepTotal > 0 ? { stepDone: Math.min(run.stepTotal, run.stepDone ?? 0), stepTotal: run.stepTotal } : {}),
      ms,
    }
  })
}

/** Runs of the lead's that answer no planned task and are running now. */
export const unplannedRunning = (flow: SpFlow, runs: readonly SpRun[], clocks: Readonly<Record<string, RunClock>>): number => {
  const titles = new Set(flow.tasks.map(t => norm(t.title)))
  return runs.filter(a => a.status === 'running' && !(a.agentId && clocks[a.agentId]?.nested) && !titles.has(norm(a.description))).length
}

export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** One run of text in a line: a theme key colour, dim or bold. */
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Line = Seg[]

const GLYPH: Record<RowState, string> = { done: '✓', review: '◆', running: '●', next: '○', waiting: '○', failed: '✗', blocked: '✗', skipped: '○' }
// Theme keys only: the band follows dark, light, /theme and skins; anything else is the theme's dim.
const COLOR: Partial<Record<RowState, string>> = { done: 'success', review: 'warning', running: 'suggestion', failed: 'error', blocked: 'error' }
const PHASE_WORD: Record<string, string> = { plan: 'plan', design: 'design', delegate: 'working', review: 'review', close: 'closing' }
const PHASE_COLOR: Record<string, string> = { delegate: 'suggestion', review: 'warning' }
const BAR_W = 6

const width = (s: string): number => [...s].length
const fit = (s: string, w: number): string => {
  const cs = [...s]
  if (w <= 0) return ''
  if (cs.length <= w) return s + ' '.repeat(w - cs.length)
  return cs.slice(0, Math.max(0, w - 1)).join('') + '…'
}
const right = (s: string, w: number): string => (width(s) >= w ? s : ' '.repeat(w - width(s)) + s)

const stateSegs = (r: Row): Seg[] => {
  const c = COLOR[r.state]
  switch (r.state) {
    case 'running':
      if (r.stepTotal) {
        const filled = Math.round((BAR_W * (r.stepDone ?? 0)) / r.stepTotal)
        return [
          { text: '━'.repeat(filled), color: c },
          { text: '─'.repeat(BAR_W - filled), dim: true },
          { text: ` ${r.stepDone ?? 0}/${r.stepTotal}` },
        ]
      }
      return [{ text: 'running', color: c }]
    case 'review':
      return [{ text: 'to review', color: c }]
    case 'done':
      return [{ text: 'done', color: c }]
    case 'failed':
      return [{ text: 'failed', color: c }]
    case 'blocked':
      return [{ text: `blocked by ${r.waitsOn.join(',')}`, color: c }]
    case 'waiting':
      return [{ text: `after ${r.waitsOn.join(',')}`, dim: true }]
    case 'skipped':
      return [{ text: 'not run', dim: true }]
    default:
      return [{ text: 'next', dim: true }]
  }
}
const segsWidth = (segs: Seg[]): number => segs.reduce((w, s) => w + width(s.text), 0)

export type Band = { header: Line; lines: Line[] }

export type Item = { kind: 'row'; r: Row } | { kind: 'fold'; rs: Row[] } | { kind: 'more'; n: number } | { kind: 'unplanned'; n: number }

/**
 * Which rows show in `budget` lines below the header: every task while they
 * fit; past 6 tasks the done rows fold into one line, and if the rest still
 * overflows, live tasks stay and the later planned ones fold into "+N more".
 */
export const pickItems = (rows: Row[], budget: number, unplanned: number): Item[] => {
  let items: Item[] = rows.map(r => ({ kind: 'row' as const, r }))
  const extraLine = unplanned > 0 ? 1 : 0
  if (rows.length > 6 || rows.length + extraLine > budget) {
    const done = rows.filter(r => r.state === 'done')
    const rest = rows.filter(r => r.state !== 'done')
    items = done.length ? [{ kind: 'fold', rs: done }] : []
    let room = budget - items.length - extraLine
    if (rest.length <= room) items.push(...rest.map(r => ({ kind: 'row' as const, r })))
    else {
      room = Math.max(0, room - 1)
      const live = rest.filter(r => r.state === 'running' || r.state === 'review' || r.state === 'failed' || r.state === 'blocked')
      const keep = new Set(live.slice(0, room).map(r => r.n))
      for (const r of rest) if (keep.size < room && !keep.has(r.n)) keep.add(r.n)
      items.push(...rest.filter(r => keep.has(r.n)).map(r => ({ kind: 'row' as const, r })))
      items.push({ kind: 'more', n: rest.length - keep.size })
    }
  }
  if (unplanned > 0 && items.length < budget) items.push({ kind: 'unplanned', n: unplanned })
  return items
}

// ART-BEGIN ------------------------------------------------------------------
// 0.5.0 "Lanes": on the desktop, mobile and editor surfaces the icons and bars
// are small vector drawings in an ocean palette; the words stay native Text, so
// they follow the person's theme and font. Mid-tones are chosen to read on both
// dark and light grounds. The designs page renders this same section.

export const OCEAN = {
  done: '#0A9396',     // teal: accepted
  run: '#0096C7',      // ocean blue: running
  review: '#EE9B00',   // amber: ready for review
  fail: '#E63946',     // coral red: failed or blocked
  track: '#8FA3B0',    // slate: still to come, empty track
}
export const SVG_FONT = "'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif"

const svgDoc = (w: number, h: number, inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`

const tickMark = (c: string): string =>
  `<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M4.9 8.3l2.1 2.1 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`

/** A 16 px state icon. `frac` (0-1) fills the running ring. */
export const iconSvg = (state: RowState | 'job' | 'clock' | 'accepted', frac = 0.25): string => {
  const P = OCEAN
  switch (state) {
    case 'done':
    case 'accepted':
      return svgDoc(16, 16, tickMark(P.done))
    case 'running': {
      const c = 2 * Math.PI * 6
      const f = Math.max(0.08, Math.min(1, frac))
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="6" fill="none" stroke="${P.track}" stroke-opacity=".35" stroke-width="2"/>` +
        `<circle cx="8" cy="8" r="6" fill="none" stroke="${P.run}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>` +
        `<circle cx="8" cy="8" r="1.7" fill="${P.run}"/>`)
    }
    case 'review':
      return svgDoc(16, 16,
        `<path d="M1.7 8c1.6-2.9 3.7-4.4 6.3-4.4s4.7 1.5 6.3 4.4c-1.6 2.9-3.7 4.4-6.3 4.4S3.3 10.9 1.7 8z" fill="none" stroke="${P.review}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<circle cx="8" cy="8" r="2.1" fill="${P.review}"/>`)
    case 'failed':
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="7" fill="${P.fail}"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`)
    case 'blocked':
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${P.fail}" stroke-width="1.5"/><path d="M3.8 12.2l8.4-8.4" stroke="${P.fail}" stroke-width="1.5" stroke-linecap="round"/>`)
    case 'skipped':
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${P.track}" stroke-width="1.4"/><path d="M5.2 8h5.6" stroke="${P.track}" stroke-width="1.4" stroke-linecap="round"/>`)
    case 'job':
      return svgDoc(16, 16,
        `<rect x="1.5" y="2.5" width="13" height="2.4" rx="1.2" fill="${P.done}"/>` +
        `<rect x="1.5" y="6.8" width="9" height="2.4" rx="1.2" fill="${P.run}"/>` +
        `<rect x="1.5" y="11.1" width="5" height="2.4" rx="1.2" fill="${P.review}"/>`)
    case 'clock':
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${P.track}" stroke-width="1.4"/><path d="M8 4.8V8l2.3 1.5" fill="none" stroke="${P.track}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`)
    default: // next, waiting
      return svgDoc(16, 16,
        `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${P.track}" stroke-width="1.4" stroke-dasharray="2.3 2.2"/>`)
  }
}

/** A slim rounded progress bar, `w` by 6 px. */
export const barSvg = (frac: number, color: string, w = 112): string => {
  const f = Math.max(0, Math.min(1, frac))
  return svgDoc(w, 6,
    `<rect x="0" y="0" width="${w}" height="6" rx="3" fill="${OCEAN.track}" fill-opacity=".28"/>` +
    (f > 0 ? `<rect x="0" y="0" width="${Math.max(6, w * f).toFixed(1)}" height="6" rx="3" fill="${color}"/>` : ''))
}

/** A soft rounded pill with a word in it: the job's phase. */
export const pillSvg = (word: string, color: string): string => {
  const w = Math.round(word.length * 6.6 + 18)
  return svgDoc(w, 18,
    `<rect x="0" y="0" width="${w}" height="18" rx="9" fill="${color}" fill-opacity=".16"/>` +
    `<text x="${w / 2}" y="12.6" text-anchor="middle" font-family="${SVG_FONT}" font-size="11" font-weight="600" fill="${color}">${word.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`)
}
// ART-END --------------------------------------------------------------------

/** The status word or bar of one lane, by state. */
const laneStatus = (r: Row): { bar?: { frac: number; color: string }; word?: string; color?: string; dim?: boolean; steps?: string } => {
  switch (r.state) {
    case 'running':
      return r.stepTotal
        ? { bar: { frac: (r.stepDone ?? 0) / r.stepTotal, color: OCEAN.run }, steps: `${r.stepDone ?? 0}/${r.stepTotal}` }
        : { bar: { frac: 0.08, color: OCEAN.run }, steps: '' }
    case 'review':
      return { bar: { frac: 1, color: OCEAN.review }, word: 'Review', color: OCEAN.review }
    case 'done':
      return { bar: { frac: 1, color: OCEAN.done }, word: 'Done', color: OCEAN.done }
    case 'failed':
      return { word: 'Failed', color: OCEAN.fail }
    case 'blocked':
      return { word: `Blocked by ${r.waitsOn.join(', ')}`, color: OCEAN.fail }
    case 'waiting':
      return { word: `after ${r.waitsOn.join(', ')}`, dim: true }
    case 'skipped':
      return { word: 'not run', dim: true }
    default:
      return { word: 'next', dim: true }
  }
}

/**
 * Lays out the checklist in `cols` cells and at most `maxLines` lines below the
 * header (6 at most). Past 6 tasks the done rows fold into one line; if the rest
 * still overflows, live tasks stay and the later planned ones fold into "+N more".
 */
export const layoutBand = (flow: SpFlow, rows: Row[], o: { cols: number; maxLines: number; elapsedMs: number; unplanned: number }): Band => {
  const cols = Math.max(24, Math.floor(o.cols))
  const budget = Math.max(1, Math.min(6, Math.floor(o.maxLines)))
  const accepted = rows.filter(r => r.state === 'done').length

  // Header: title on the left; phase · accepted · elapsed on the right.
  const phase = flow.isFinished ? 'done' : PHASE_WORD[flow.phase] ?? flow.phase
  const tail: Seg[] = [
    { text: phase, color: flow.isFinished ? 'success' : PHASE_COLOR[flow.phase], dim: !flow.isFinished && !PHASE_COLOR[flow.phase] },
    { text: ' · ', dim: true },
    { text: cols < 52 ? `${accepted}/${rows.length}` : `${accepted}/${rows.length} accepted` },
    { text: ' · ', dim: true },
    { text: fmtTime(o.elapsedMs), bold: true },
  ]
  const tailW = segsWidth(tail)
  const titleW = Math.max(4, cols - tailW - 2)
  const title = width(flow.title) > titleW ? fit(flow.title, titleW) : flow.title
  const header: Line = [{ text: title, bold: true }, { text: ' '.repeat(Math.max(2, cols - width(title) - tailW)) }, ...tail]

  const items = pickItems(rows, budget, o.unplanned)

  // Columns.
  const shown = items.flatMap(it => (it.kind === 'row' ? [it.r] : []))
  const numW = String(rows.length).length
  const times = shown.map(r => (r.ms === null ? '–' : fmtTime(r.ms)))
  const timeW = Math.max(5, ...times.map(width))
  const stateW = Math.min(14, Math.max(9, ...shown.map(r => segsWidth(stateSegs(r))))) + 1
  let agentW = Math.min(16, Math.max(6, ...shown.map(r => width(r.agent)))) + 2
  const fixed = 2 + numW + 1 + stateW + 1 + timeW
  let taskW = cols - fixed - agentW
  if (taskW < 10) {
    agentW = 0
    taskW = cols - fixed
  }
  taskW = Math.max(6, Math.min(taskW, Math.max(10, ...shown.map(r => width(r.title) + 2))))

  const lines: Line[] = items.map((it): Line => {
    if (it.kind === 'fold') {
      const nums = it.rs.map(r => r.n).join(', ')
      return [{ text: '✓', color: 'success' }, { text: ` ${it.rs.length} done`, color: 'success' }, { text: fit(` (${nums})`, cols - 8 - String(it.rs.length).length), dim: true }]
    }
    if (it.kind === 'more') return [{ text: `○ +${it.n} more (/agents-info lists all)`, dim: true }]
    if (it.kind === 'unplanned') return [{ text: '●', color: 'suggestion' }, { text: ` +${it.n} unplanned run${it.n === 1 ? '' : 's'} running`, dim: true }]
    const r = it.r
    const isQuiet = r.state === 'next' || r.state === 'waiting' || r.state === 'skipped'
    const isLive = r.state === 'running' || r.state === 'review'
    const st = stateSegs(r)
    const time = r.ms === null ? '–' : fmtTime(r.ms)
    return [
      { text: GLYPH[r.state], color: COLOR[r.state], dim: !COLOR[r.state] },
      { text: ` ${right(String(r.n), numW)} `, dim: isQuiet },
      { text: fit(r.title, taskW - 1) + ' ', bold: isLive, dim: isQuiet },
      ...(agentW ? [{ text: fit(r.agent, agentW), dim: true }] : []),
      ...st,
      { text: ' '.repeat(Math.max(1, stateW - segsWidth(st))) },
      { text: right(time, timeW), dim: r.state === 'done' || isQuiet },
    ]
  })
  return { header, lines }
}

type Els = { Box: (p: Record<string, unknown>) => unknown; Text: (p: Record<string, unknown>) => unknown; Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }

/**
 * The 0.5.0 "Lanes" band for graphical surfaces: a header (job mark, title,
 * phase pill; accepted count, clock, ✕) and one lane per task: state icon,
 * task, agent, slim bar or status word, steps and active time. Rows are picked
 * as in the text band (done rows fold past 6 tasks; never more than 6 lines).
 */
export const lanesTree = (
  el: Els,
  flow: SpFlow,
  rows: Row[],
  o: { maxLines: number; elapsedMs: number; unplanned: number; cols: number },
  close: unknown,
): unknown => {
  const { Box, Text, Svg } = el
  const budget = Math.max(1, Math.min(6, Math.floor(o.maxLines)))
  const accepted = rows.filter(r => r.state === 'done').length
  const icon = (state: Parameters<typeof iconSvg>[0], alt: string, frac?: number, size = 16) =>
    Box({ width: 2, flexShrink: 0, alignItems: 'center', children: [Svg({ source: iconSvg(state, frac), alt, width: size, height: size })] })
  const T = (text: string, p: Record<string, unknown> = {}) => Text({ wrap: 'truncate-end', ...p, children: [text] })

  const phaseWord = flow.isFinished ? 'Done' : ({ plan: 'Planning', design: 'Design', delegate: 'Working', review: 'Review', close: 'Closing' } as Record<string, string>)[flow.phase] ?? flow.phase
  const phaseColor = flow.isFinished ? OCEAN.done : flow.phase === 'review' ? OCEAN.review : OCEAN.run
  const header = Box({
    flexDirection: 'row', gap: 1, alignItems: 'center',
    children: [
      icon('job', 'job'),
      Box({ flexShrink: 1, children: [T(flow.title, { bold: true })] }),
      Svg({ source: pillSvg(phaseWord, phaseColor), alt: phaseWord, height: 18 }),
      Box({ flexGrow: 1 }),
      icon('accepted', 'accepted', undefined, 13),
      T(flow.isFinished ? `All ${rows.length} accepted` : `${accepted} of ${rows.length} accepted`, { dimColor: true }),
      icon('clock', 'elapsed', undefined, 13),
      T(fmtTime(o.elapsedMs), { bold: true }),
      close,
    ],
  })

  // Finished: one calm line under the header.
  if (flow.isFinished) {
    const last = [...rows].reverse().find(r => r.state === 'done')
    return Box({ flexDirection: 'column', children: [header, Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
      icon('done', 'done'), T(`All ${rows.length} tasks accepted`, { bold: true }),
      T(last ? `Last: ${last.title}${last.isAgentKnown ? ` by ${last.agent}` : ''}.` : '', { dimColor: true }),
    ] })] })
  }

  const items = pickItems(rows, budget, o.unplanned)
  const shown = items.flatMap(it => (it.kind === 'row' ? [it.r] : []))
  const taskW = Math.max(10, Math.min(28, Math.floor(o.cols * 0.3), ...shown.map(r => width(r.title) + 1)))
  const agentW = o.cols >= 60 ? Math.min(18, Math.max(8, ...shown.map(r => width(r.agent) + 1))) : 0
  const barCells = o.cols >= 70 ? 16 : 10

  const lanes = items.map(it => {
    if (it.kind === 'fold') {
      return Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
        icon('done', 'accepted'), T(`${it.rs.length} accepted`, { bold: true, color: OCEAN.done }),
        Box({ flexShrink: 1, children: [T(it.rs.map(r => r.title).join(', '), { dimColor: true })] }),
      ] })
    }
    if (it.kind === 'more') return Box({ flexDirection: 'row', gap: 1, children: [icon('next', 'more'), T(`+${it.n} more · /agents-info lists all`, { dimColor: true })] })
    if (it.kind === 'unplanned') return Box({ flexDirection: 'row', gap: 1, children: [icon('running', 'unplanned'), T(`+${it.n} unplanned run${it.n === 1 ? '' : 's'} running`, { dimColor: true })] })
    const r = it.r
    const quiet = r.state === 'next' || r.state === 'waiting' || r.state === 'skipped'
    const live = r.state === 'running' || r.state === 'review'
    const st = laneStatus(r)
    const frac = r.stepTotal ? (r.stepDone ?? 0) / r.stepTotal : 0.25
    return Box({
      flexDirection: 'row', gap: 1, alignItems: 'center',
      children: [
        icon(r.state, r.state, frac),
        Box({ width: taskW, flexShrink: 1, children: [T(r.title, { bold: live, dimColor: quiet })] }),
        ...(agentW ? [Box({ width: agentW, flexShrink: 1, children: [T(r.agent, { dimColor: true })] })] : []),
        Box({ flexGrow: 1 }),
        Box({ width: barCells, flexShrink: 0, alignItems: 'center', children: [
          st.bar ? Svg({ source: barSvg(st.bar.frac, st.bar.color, barCells * 7), alt: `${Math.round(st.bar.frac * 100)} percent`, width: barCells * 7, height: 6 })
                 : T(st.word ?? '', { dimColor: !!st.dim, ...(st.color ? { color: st.color } : {}) }),
        ] }),
        Box({ width: 7, flexShrink: 0, children: [T(st.bar ? (st.steps ?? st.word ?? '') : '', { ...(st.steps ? { dimColor: true } : st.color ? { color: st.color, bold: true } : {}) })] }),
        Box({ width: 7, flexShrink: 0, justifyContent: 'flex-end', children: [T(r.ms === null ? '' : fmtTime(r.ms), { dimColor: r.state === 'done' || quiet })] }),
      ],
    })
  })
  return Box({ flexDirection: 'column', children: [header, ...lanes] })
}

// ---------------------------------------------------------------------------

// Our own calls to the progress tool skip this plugin's own tool.call hook.
let ownCalls = 0
const report = async ($: EngineInterface, input: Record<string, unknown>): Promise<void> => {
  ownCalls++
  try {
    await $.tool.call({ tool: PROGRESS, ...input })
  } catch {
    // savvy-progress missing or the call refused: the bar is a nicety, never a blocker.
  } finally {
    ownCalls--
  }
}

// Parallel spawns read and re-send the task list; one at a time keeps every row.
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

// Set while this plugin re-sends a saved bar, so savvy-progress keeps the panel's runs.
let isRestoring = false
// Set while the checklist's ✕ asks savvy-progress for a write that this plugin turns into null.
let isClosing = false
// Runs that ended before the delayed auto-tracker saw them: agent id → answered.
const early = new Map<string, boolean>()

/** What the band hook saw last: read by `/progress-bar check`. A render hook cannot write state, so it lives here. */
type Seen = { at: number; band: 'checklist' | 'savvy-progress' | 'none'; reason: string; beneath: string[]; isOutside: boolean }
let seen: Seen | null = null

const saved = (f: SavedFlow): SavedFlow => ({
  title: f.title,
  total: f.total,
  done: f.done,
  phase: f.phase,
  isFinished: f.isFinished,
  tasks: (f.tasks ?? []).map(t => ({ title: t.title, tier: t.tier, after: [...(t.after ?? [])] })),
})

const barKey = async ($: EngineInterface): Promise<string> => BAR_PREFIX + (await $.session.id())

const readBar = async ($: EngineInterface): Promise<SavedBar | null> => {
  const bar = (await $.store.get(await barKey($))) as SavedBar | undefined
  return bar && bar.flow ? bar : null
}

const writeBar = async ($: EngineInterface, flow: SavedFlow, hidden: boolean): Promise<void> => {
  const sid = await $.session.id()
  const job = ((await $.state.get(JOB))?.value ?? null) as JobClock | null
  const bar: SavedBar = { sid, savedAt: await $.clock.now(), hidden, flow: saved(flow), ...(job && job.title === flow.title ? { job } : {}) }
  await $.state.set(LAST, bar.flow)
  await $.store.set(BAR_PREFIX + sid, bar)
}

/** This session's bar only: the state copy, else the store copy (after /resume or a restart). */
const loadBar = async ($: EngineInterface): Promise<SavedBar | null> => {
  const held = (await $.state.get(LAST))?.value ?? null
  const stored = await readBar($)
  if (held) return { sid: stored?.sid ?? '', savedAt: stored?.savedAt ?? 0, hidden: (await $.state.get(HIDDEN))?.value === true, flow: held, ...(stored?.job ? { job: stored.job } : {}) }
  return stored
}

type Run = { type: string; description: string; model?: string; status: string }

export const rebuild = (runs: readonly Run[]): SavedFlow | null => {
  const named = runs.filter(a => a.description.trim())
  if (!named.length) return null
  // One row per title; a retake counts once, done when any of its runs answered.
  const firsts = named.filter((a, i) => named.findIndex(b => b.description.trim() === a.description.trim()) === i)
  const isDone = (title: string) => named.some(a => a.description.trim() === title && a.status === 'done')
  return {
    title: 'Agents',
    total: firsts.length,
    done: firsts.filter(a => isDone(a.description.trim())).length,
    phase: named.some(a => a.status === 'running') ? 'delegate' : 'review',
    isFinished: false,
    tasks: firsts.map(a => ({ title: a.description.trim(), tier: tierOf(a.type, a.model), after: [] })),
  }
}

/** Re-sends a saved bar. `force` (the /progress-bar command) also shows a closed or finished one. */
const restore = async ($: EngineInterface, force: boolean): Promise<string> => {
  const flow = (await $.state.get(FLOW))?.value ?? null
  if (flow) return `The progress bar is already showing: ${flow.title}.`
  const bar = await loadBar($)
  const last = bar?.flow ?? (force ? rebuild((await $.state.get(AGENTS))?.value ?? []) : null)
  if (!last) return 'There is no progress bar of this session to bring back.'
  if (!force && (last.isFinished || bar?.hidden)) return ''
  // Keep the job's own clock: a restore must not restart the elapsed time.
  if (bar?.job && bar.job.title === last.title) await $.state.set(JOB, bar.job)
  isRestoring = true
  try {
    await report($, {
      title: last.title,
      phase: last.phase,
      total: last.total,
      done: Math.min(last.done, last.total || last.done),
      tasks: last.tasks,
      ...(last.isFinished ? { finished: true } : {}),
    })
  } finally {
    isRestoring = false
  }
  await $.state.set(HIDDEN, false)
  const now = (await $.state.get(FLOW))?.value ?? null
  return now ? `Progress bar restored: ${now.title} (${now.done}/${now.total}).` : 'Could not restore the progress bar: savvy-progress did not take the call.'
}

/** The checklist's ✕: asks savvy-progress for a write and turns it into null, exactly as its own ✕ does. */
const closeBar = async ($: EngineInterface): Promise<void> => {
  isClosing = true
  try {
    await report($, {})
  } finally {
    isClosing = false
  }
}

/** Opens or extends an auto bar for one run, unless the lead has reported or the bar was closed. */
const track = async ($: EngineInterface, agentId: string, task: Task, team: string): Promise<void> => {
  const flow = (await $.state.get(FLOW))?.value ?? null
  const auto = (await $.state.get(AUTO))?.value ?? null
  const active = flow && !flow.isFinished ? flow : null
  const isOurs = !!active && !!auto && auto.title === active.title
  // The lead runs this bar: the panel lists the run already; adding it to the plan only inflates the total.
  if (active && !isOurs) return
  // Closed with ✕ and nothing new since: keep it closed.
  if (!active && (await $.state.get(HIDDEN))?.value === true) return

  const answered = early.get(agentId)
  early.delete(agentId)
  const ended = answered === undefined ? [] : [agentId]
  const doneAdd = answered ? 1 : 0

  if (active && auto && isOurs) {
    if (auto.runs.includes(agentId)) return
    const next: AutoFlow = { ...auto, runs: [...auto.runs, agentId], ended: [...auto.ended, ...ended], done: auto.done + doneAdd }
    await report($, { tasks: [...active.tasks, task], done: next.done, phase: next.ended.length >= next.runs.length ? 'review' : 'delegate' })
    await $.state.set(AUTO, next)
    return
  }
  const fresh: AutoFlow = { title: team, runs: [agentId], ended, done: doneAdd }
  await report($, { title: team, phase: ended.length ? 'review' : 'delegate', done: doneAdd, tasks: [task] })
  await $.state.set(AUTO, fresh)
}

const ago = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** `/progress-bar check`: the guard's view in plain words. */
const check = async ($: EngineInterface, isBandOn: boolean): Promise<string> => {
  const flow = (await $.state.get(FLOW))?.value ?? null
  const agents = (await $.state.get(AGENTS))?.value ?? []
  const flowProblem = flow === null ? '' : flowShapeProblem(flow)
  const agentsProblem = agentsShapeProblem(agents)
  const shapeOk = !flowProblem && !agentsProblem
  const now = await $.clock.now()
  const out: string[] = []

  if (!isBandOn) out.push('Verdict: the checklist band is switched off (setting checklistBand = false). savvy-progress draws its own bar.')
  else if (!seen) out.push('Verdict: not known yet. No band has been drawn since savvy-teams loaded.')
  else if (seen.band === 'checklist') out.push('Verdict: the new checklist band is active. savvy-progress\'s old row is hidden.')
  else if (seen.band === 'savvy-progress') out.push(`Verdict: the old savvy-progress bar is showing. The checklist stays off because ${seen.reason}.`)
  else out.push('Verdict: no bar is live right now, so neither band is drawn.')

  if (seen) {
    const others = seen.beneath.filter(p => !isSp(p))
    out.push(
      seen.isOutside
        ? `Hook order: savvy-teams sits outside savvy-progress, so it can replace savvy-progress's row (seen ${ago(now - seen.at)} ago${others.length ? `; other bands beneath: ${others.join(', ')}` : ''}).`
        : `Hook order: savvy-progress is NOT beneath savvy-teams (beneath it: ${seen.beneath.length ? seen.beneath.join(', ') : 'nothing'}). savvy-teams cannot replace the row, so the old bar stays. Fallback: the same-name fork (see the build notes).`,
    )
  } else {
    out.push('Hook order: not seen yet.')
  }
  out.push(
    flow === null
      ? `savvy-progress state: no live bar to check${agentsProblem ? `; agents list: ${agentsProblem}` : ` (agents list OK, ${agents.length} run${agents.length === 1 ? '' : 's'})`}.`
      : shapeOk
        ? `savvy-progress state: matches 1.2.1 ("${flow.title}", ${flow.tasks.length} tasks, ${agents.length} runs).`
        : `savvy-progress state: does not match 1.2.1 (${flowProblem || agentsProblem}).`,
  )
  if (!seen || flow === null) out.push('To test: start a job with 2 or more agents (or type /progress-bar to bring back the last bar), then run /progress-bar check again.')
  return out.join('\n')
}

export const register: Register = (on, options) => {
  const opt = options as { leadRule?: boolean; workerRule?: boolean; autoTrack?: boolean; noStepAgents?: string; checklistBand?: boolean; teams?: string }
  const teams = parseTeams(opt.teams)
  const leadRule = opt.leadRule !== false
  const workerRule = opt.workerRule !== false
  const autoTrack = opt.autoTrack !== false
  const isBandOn = opt.checklistBand !== false
  // An empty pattern names no agent (new RegExp('') would match every one).
  let noStep: RegExp | null = null
  try {
    noStep = opt.noStepAgents ? new RegExp(opt.noStepAgents) : null
  } catch {
    noStep = null
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Bring back this session\'s progress bar (after ✕, /resume or a restart); "check" says which band is active and why', argumentHint: '[check]' })
    // Prune saved bars older than a week, and the one global key of 0.2.0 that leaked across sessions.
    try {
      const now = await $.clock.now()
      await $.store.delete('last')
      for (const key of await $.store.keys()) {
        if (!key.startsWith(BAR_PREFIX)) continue
        const bar = (await $.store.get(key)) as SavedBar | undefined
        if (!bar || now - bar.savedAt > KEEP_MS) await $.store.delete(key)
      }
    } catch {
      // A store that cannot be read is no reason to stop the session.
    }
    // A restarted, resumed session gets its bar back once savvy-progress has registered its tools.
    $.clock.after(RESTORE_DELAY_MS, () => void restore($, false))
    // The job clock moves while the checklist shows and no agent runs (savvy-progress ticks its own `now` while one does).
    if (isBandOn) {
      let lastTick = 0
      $.clock.every(1000, () => {
        void (async () => {
          if (seen?.band !== 'checklist') return
          const flow = (await $.state.get(FLOW))?.value ?? null
          if (!flow || flow.isFinished) return
          const agents = (await $.state.get(AGENTS))?.value ?? []
          if (agents.some(a => a.status === 'running')) return
          const now = await $.clock.now()
          const lastWork = Math.max(0, ...agents.map(a => a.endedAt ?? a.startedAt))
          if (now - lastWork > IDLE_SLOW_MS && now - lastTick < 60_000) return
          lastTick = now
          await $.state.set(TICK, now)
        })().catch(() => undefined)
      })
    }
    return started
  })

  // /resume and /branch reset $.state and skip session.start: bring this session's bar back.
  on('classic.SessionStart', { source: ['resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    $.clock.after(RESTORE_DELAY_MS, () => void restore($, false))
    return r
  })

  // Keep a per-session copy of every bar savvy-progress draws; a null write is the ✕.
  on('state.set', { plugin: 'savvy-progress', key: 'flow' }, async ($, e, next) => {
    const value = e.value as SavedFlow | null
    // The checklist's ✕: this write becomes null, as savvy-progress's own ✕ writes.
    if (isClosing && value) {
      const written = await next({ ...e, value: null } as typeof e)
      try {
        await writeBar($, ((e.previous ?? null) as SavedFlow | null) ?? value, true)   // 0.4.1 (review F1): keep the real job, not the blank flow
        await $.state.set(HIDDEN, true)
        await $.state.set(AUTO, null)
      } catch {
        // Saving is a nicety.
      }
      return written
    }
    const written = await next(e)
    try {
      if (value) {
        // The job's wall clock: starts with a new title (or a new bar after a finished one), stops at finished.
        const now = await $.clock.now()
        const job = ((await $.state.get(JOB))?.value ?? null) as JobClock | null
        const prev = (e.previous ?? null) as SavedFlow | null
        const isNew = !job || job.title !== value.title || (!!prev && prev.isFinished && !value.isFinished)
        const nextJob: JobClock = isNew ? { title: value.title, startedAt: now } : job
        const stamped: JobClock = value.isFinished ? { ...nextJob, endedAt: nextJob.endedAt ?? now } : { title: nextJob.title, startedAt: nextJob.startedAt }
        if (isNew || stamped.endedAt !== job?.endedAt) await $.state.set(JOB, stamped)
        await writeBar($, value, false)
        await $.state.set(HIDDEN, false)
      } else if (e.previous) {
        await writeBar($, e.previous as SavedFlow, true)
        await $.state.set(HIDDEN, true)
        await $.state.set(AUTO, null)
      }
    } catch {
      // Saving is a nicety.
    }
    return written
  })

  // A restore re-sends the title, which savvy-progress reads as a new flow and
  // drops its finished runs; keep the panel as it stood instead.
  on('state.set', { plugin: 'savvy-progress', key: 'agents' }, ($, e, next) =>
    isRestoring && e.previous !== undefined ? next({ ...e, value: e.previous as typeof e.value }) : next(e),
  )

  // The lead's own progress calls. Works only if this hook sits outside savvy-progress's
  // handler in the chain (test 6 checks); if not, it is simply never reached.
  on('tool.call', { tool: PROGRESS }, async ($, e, next) => {
    if (e.agentId) return { result: 'ignored: only the main session reports the flow (workers use mcp__savvy-progress__step)' }
    if (ownCalls > 0 || isRestoring) return next(e)
    const input = e as unknown as { title?: string; tasks?: Task[]; total?: number; done?: number; phase?: string; finished?: boolean }
    if (input.title !== undefined) {
      await $.state.set(HIDDEN, false)
      return next(e)
    }
    const flow = (await $.state.get(FLOW))?.value ?? null
    if (flow && !flow.isFinished) return next(e)
    const bar = await loadBar($)
    if (!bar || bar.flow.isFinished) return next(e)
    const tasks = input.tasks ?? bar.flow.tasks
    const total = input.total ?? (input.tasks ? input.tasks.length : bar.flow.total)
    if (bar.hidden) {
      // Closed with ✕: keep counting in the saved copy, draw nothing.
      await writeBar($, { ...bar.flow, tasks: tasks.map(t => ({ ...t, after: t.after ?? [] })), total, done: Math.min(input.done ?? bar.flow.done, total || Infinity), phase: input.phase ?? bar.flow.phase, isFinished: input.finished === true }, true)
      return { result: 'ok: hidden (closed with ✕; /progress-bar brings it back)' }
    }
    // The bar was lost (/resume, /clear, restart, or a done-only call after finished): carry the saved plan into this call.
    if (bar.job && bar.job.title === bar.flow.title) await $.state.set(JOB, bar.job)
    return next({ ...e, title: bar.flow.title, tasks, total, phase: input.phase ?? bar.flow.phase, done: input.done ?? bar.flow.done } as typeof e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (String(e.args ?? '').trim().toLowerCase() === 'check') return { text: await check($, isBandOn) }
    return { text: await restore($, true) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!leadRule || e.traits.includes('bare')) return composed
    if (composed.sections.some(s => s.id === 'savvy-teams:lead')) return composed
    return { ...composed, sections: [...composed.sections, { id: 'savvy-teams:lead', text: LEAD_RULE, scope: 'session' as const }] }
  })

  on('agent.spawn', async ($, e, next) => {
    const type = bare(e.subagentType)
    const isSavvy = type.startsWith('savvy-')
    const addRule = workerRule && !e.fork && !isSavvy && !noStep?.test(type) && !e.prompt.includes(STEP) && (await needOf($, type)) === 'add'
    const started = await next(addRule ? { ...e, prompt: e.prompt + WORKER_RULE } : e)

    const agentId = started.agentId
    // The run's active-time clock (0.4.0): open from now; a SendMessage resume reopens it in turn.step.
    if (started.deny === undefined && agentId) {
      try {
        const at = await $.clock.now()
        await $.state.set({ ...CLOCK, id: agentId }, { activeMs: 0, since: at, rounds: 1, nested: !!e.parentAgentId })
      } catch {
        // Time falls back to savvy-progress's wall clock.
      }
    }

    const title = e.description.trim()
    if (!autoTrack || started.deny !== undefined || !agentId || e.parentAgentId || e.fork || isSavvy || !title) return started

    const task: Task = { title, tier: tierOf(e.subagentType, started.model) }
    const team = teamOf(e.subagentType, teams)
    // Wait a moment: a lead that plans in the same message gets its bar in first.
    $.clock.after(AUTO_DELAY_MS, () => void serial(() => track($, agentId, task, team)))
    return started
  })

  // A subagent's model request: if its clock is idle, it was resumed (SendMessage); reopen the span.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId) {
      try {
        const ref = { ...CLOCK, id: agentId }
        const clock = (await $.state.get(ref))?.value
        if (clock && clock.since === null) await $.state.set(ref, { ...clock, since: await $.clock.now(), rounds: clock.rounds + 1 })
      } catch {
        // Time falls back to savvy-progress's wall clock.
      }
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Close the run's open span: the idle gap until a resume is not counted.
    if (e.agentId) {
      try {
        const ref = { ...CLOCK, id: e.agentId }
        const clock = (await $.state.get(ref))?.value
        if (clock && clock.since !== null) {
          const at = await $.clock.now()
          await $.state.set(ref, { ...clock, activeMs: clock.activeMs + Math.max(0, at - clock.since), since: null })
        }
      } catch {
        // Time falls back to savvy-progress's wall clock.
      }
    }
    if (autoTrack) {
      await serial(async () => {
        const auto = (await $.state.get(AUTO))?.value ?? null
        if (e.agentId && !(auto && auto.runs.includes(e.agentId))) {
          // Ended before the delayed tracker saw it (or not ours): remember for track().
          if (early.size > 200) early.clear()
          early.set(e.agentId, e.reason === 'answer')
        }
        if (!auto) return
        const flow = (await $.state.get(FLOW))?.value ?? null
        const isLive = !!flow && !flow.isFinished && flow.title === auto.title

        if (!isLive) {
          // The lead took over with its own title, or the bar was closed.
          await $.state.set(AUTO, null)
          return
        }
        if (e.agentId) {
          if (!auto.runs.includes(e.agentId) || auto.ended.includes(e.agentId)) return
          const done = auto.done + (e.reason === 'answer' ? 1 : 0)
          const ended = [...auto.ended, e.agentId]
          await $.state.set(AUTO, { ...auto, ended, done })
          await report($, { done, phase: ended.length >= auto.runs.length ? 'review' : 'delegate' })
          return
        }
        // The main turn ended: close the bar once every tracked run has ended.
        if (auto.ended.length >= auto.runs.length) {
          await report($, { done: auto.done, finished: true })
          await $.state.set(AUTO, null)
        }
      })
    }
    return next(e)
  })

  // The checklist band. Guard: draw ours and drop savvy-progress's row ONLY when
  // (1) its state matches 1.2.1, (2) savvy-progress ran beneath this hook, and
  // (3) its answer is the 1.2.1 band with its own row found. Anything else:
  // savvy-progress's answer goes through untouched. Never two bars, never none.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await next(e)
    const at = await $.clock.now()
    const beneath = [...new Set(next.trace.map(t => String(t.plugin)).filter(p => p !== 'engine'))]
    const spRan = next.trace.some(t => isSp(t.plugin) && (t.outcome === 'returned' || t.outcome === 'passed'))
    const isOutside = beneath.some(isSp)
    const leave = (band: Seen['band'], reason: string) => {
      seen = { at, band, reason, beneath, isOutside }
      return drawn
    }
    if (!isBandOn) return leave('savvy-progress', 'the setting checklistBand is off')

    const flowValue = (await $.state.get(FLOW))?.value ?? null
    if (flowValue === null) return leave('none', 'no bar is live')
    if (e.props.hasSurvey) return leave('savvy-progress', 'a survey holds the band')
    const agentsValue = (await $.state.get(AGENTS))?.value ?? []
    const shape = flowShapeProblem(flowValue) || agentsShapeProblem(agentsValue)
    if (shape) return leave('savvy-progress', `savvy-progress's state does not match 1.2.1 (${shape})`)
    if (!isOutside) return leave('savvy-progress', 'savvy-progress is not beneath savvy-teams in the hook chain')
    if (!spRan) return leave('savvy-progress', 'savvy-progress did not draw its band beneath savvy-teams')
    const split = splitSpBand(drawn)
    if (!split.ok) return leave('savvy-progress', split.reason)

    try {
      const flow = flowValue as unknown as SpFlow
      const runs = agentsValue as unknown as SpRun[]
      const clocks: Record<string, RunClock> = {}
      for (const a of runs) {
        if (!a.agentId) continue
        const c = (await $.state.get({ ...CLOCK, id: a.agentId }))?.value
        if (c) clocks[a.agentId] = c
      }
      // Reading these subscribes the band: savvy-progress ticks `now` each second while an agent runs, this plugin `tick` otherwise.
      const spNow = Number((await $.state.get(SP_NOW))?.value ?? 0)
      const tick = Number((await $.state.get(TICK))?.value ?? 0)
      const job = ((await $.state.get(JOB))?.value ?? null) as JobClock | null
      const now = Math.max(at, spNow, tick)
      const rows = deriveRows(flow, runs, clocks, now)
      const firstStart = runs.length ? Math.min(...runs.map(a => a.startedAt)) : now
      const jobStart = job && job.title === flow.title ? job.startedAt : firstStart
      const jobEnd = job && job.title === flow.title && job.endedAt !== undefined ? job.endedAt : now
      const cols = Math.max(24, (e.props.bodyColumns || 80) - 4)
      const band = layoutBand(flow, rows, {
        cols,
        maxLines: Math.min(6, (e.props.maxRows || 8) - 1),
        elapsedMs: Math.max(0, jobEnd - jobStart),
        unplanned: unplannedRunning(flow, runs, clocks),
      })

      const ui = $.ui.resolve(e)
      const { Box, Text, Button } = ui
      const mono = false   // 0.4.1 (review F2): older engines refuse Text mono/tabular and the band would vanish
      const text = (line: Line) =>
        Text({
          ...(mono ? { mono: true, tabular: true } : {}),
          wrap: 'truncate-end',
          children: line.map(s =>
            Text({ ...(s.color ? { color: s.color } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}), children: [s.text] }),
          ),
        })
      const close = Button({ key: CLOSE_KEY, label: '✕', plain: true, role: 'dismiss', onPress: () => void closeBar($) })
      const Svg = (ui as unknown as { Svg?: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }).Svg
      const ours = e.surface !== 'terminal' && Svg
        ? lanesTree({ Box, Text, Svg }, flow, rows, {
            maxLines: Math.min(6, (e.props.maxRows || 8) - 1),
            elapsedMs: Math.max(0, jobEnd - jobStart),
            unplanned: unplannedRunning(flow, runs, clocks),
            cols,
          }, close)
        : Box({
            flexDirection: 'column',
            children: [Box({ flexDirection: 'row', gap: 1, children: [Box({ flexGrow: 1, children: [text(band.header)] }), close] }), ...band.lines.map(text)],
          })
      seen = { at, band: 'checklist', reason: 'all checks passed', beneath, isOutside }
      return split.below ? Box({ flexDirection: 'column', children: [ours, split.below as never] }) : ours
    } catch (err) {
      return leave('savvy-progress', `the checklist failed to draw (${err instanceof Error ? err.message : String(err)})`)
    }
  })
}
