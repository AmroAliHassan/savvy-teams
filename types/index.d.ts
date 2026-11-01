/** A progress flow this plugin opened because the lead had not reported one. */
export type AutoFlow = {
  title: string
  /** Agent ids of the runs it tracks. */
  runs: string[]
  /** Runs that have ended, answered or not. */
  ended: string[]
  /** Runs that answered. */
  done: number
}

/** The last bar savvy-progress showed, kept so it can come back after ✕, /resume or a restart. */
export type SavedFlow = {
  title: string
  total: number
  done: number
  phase: string
  isFinished: boolean
  tasks: Array<{ title: string; tier: string; after: number[] }>
}

/** When the job on the bar started and, once finished, ended (wall clock, ms). */
export type JobClock = {
  title: string
  startedAt: number
  endedAt?: number
}

/** One session's saved bar in the store, under `bar:<session id>`. */
export type SavedBar = {
  sid: string
  savedAt: number
  /** Closed with ✕: stays closed until a new title or /progress-bar. */
  hidden: boolean
  flow: SavedFlow
  /** 0.4.0: the job's own clock, so /resume keeps the real elapsed time. */
  job?: JobClock
}

/**
 * One subagent's active time: spans from its start (or a SendMessage resume)
 * to the end of its turn, so the idle gap between rounds is not counted.
 */
export type RunClock = {
  /** Time already spent in closed spans. */
  activeMs: number
  /** Start of the open span, or null while the agent is idle. */
  since: number | null
  /** 1 at spawn, +1 for each resume. */
  rounds: number
  /** Spawned by another subagent, not by the lead. */
  nested: boolean
}

// What this plugin reads of savvy-progress 1.2.1's state. Checked at run time
// (flowShapeProblem, agentsShapeProblem) before the checklist band draws.
export type SpTask = { title: string; tier: string; after: number[] }

export type SpFlow = {
  title: string
  total: number
  done: number
  running: number
  phase: string
  isFinished: boolean
  tasks: SpTask[]
}

export type SpRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  round?: number
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-teams': {
      auto: AutoFlow | null
      last: SavedFlow | null
      hidden: boolean
      job: JobClock | null
      /** Once a second while a live bar shows the checklist and no agent runs, so the job clock moves. */
      tick: number
      clock: StateFamily<RunClock>
    }
  }
}
