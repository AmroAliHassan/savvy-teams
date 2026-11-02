# savvy-teams

A companion to [savvy-progress](https://github.com/johnnyvizz/claude-kit) for Claude Code. It redraws the progress bar above the prompt as **one calm surface** that looks like part of the app:

- **The job header:** one bar with a softly pulsing live dot, the job name, a phase chip (Working, Review, Done), "N of M accepted", a slim meter with one cell per task, and the elapsed time. **Agents** and **✕**, the app's own buttons, sit inside its right end.
- **The list card:** one bar. It starts with the accepted tasks folded into a single line, then up to four live tasks on fixed columns: task, agent, a segmented step track, steps or state, and minutes. "+N more" ends the card.
- **Colour only where something is alive:**

  | Colour | Meaning |
  |---|---|
  | blue | running |
  | amber | ready for your review |
  | teal | accepted |
  | coral | failed |
  | slate | waiting |

- **Quiet motion:** the current step glows on one row at a time.
- **Full-line bars:** on the desktop app every bar runs to the band's right edge whatever the window's width. Each is built from a drawn start, a fill the app stretches over the room left, and a drawn rounded end, so no width is guessed.
- **Light work:** times are shown to the minute, so the drawings change at most once a minute and are reused in between.
- **The Agents panel** (`/agents-info`) is redrawn in black and white: plain cards, ink progress bars, and coral only for a failed run.
- **Desktop and terminal:** on the desktop app, every word sits inside the drawings and follows your light or dark theme. In the terminal the band is plain, theme-coloured text.

It also does the following:

- **Lead rule.** It tells the main session how to plan the bar: one call before delegating, task titles that match the agent descriptions, and an accepted count.
- **Step rule.** It tells each subagent to report its steps, sent alongside real work and never alone.
  - It is skipped for agents whose own file already has the rule.
  - It is also skipped for agents whose `tools:` list cannot call the step tool.
- **Saved bar.** It saves each session's bar, so `/resume` and restarts bring it back.
- **Auto-tracking.** It puts runs on the bar by itself when the lead forgets to plan.
- **Safety guard.** It draws only when a run-time guard confirms it can replace savvy-progress's own row. Otherwise the stock bar shows, so you never get two bars or none.

## Install

First install savvy-progress, which this mod builds on. At the prompt of a terminal session:

```
/plugin marketplace add johnnyvizz/claude-kit
/plugin install savvy-progress@claude-kit
```

Then install savvy-teams. At the prompt of a terminal session:

```
/plugin install savvy-teams --marketplace AmroAliHassan/savvy-teams
```

From a shell:

```
claude plugin install savvy-teams --marketplace AmroAliHassan/savvy-teams
```

In the desktop app, where `/plugin` does not run:
1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace** and enter `AmroAliHassan/savvy-teams`.
3. Choose **Add plugin**.

Restart Claude Code, then type `/progress-bar check` to see which bar is active and why.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `checklistBand` | on | Draw this band in place of savvy-progress's bar. Off: the stock bar. |
| `colourCards` | on | The one-surface band and the black-and-white Agents panel. Off: the plain text band and savvy-progress's own panel. |
| `leadRule` | on | Add the planning rule to the main session's system prompt. |
| `workerRule` | on | Tell subagents to report their steps. |
| `autoTrack` | on | Put subagent runs on the bar when the lead has not planned. |
| `noStepAgents` | empty | Optional regex of agent types that never get the step rule. |
| `teams` | empty | Titles for auto-tracked bars, as `regex=Name` pairs split by `;` (for example `^yt-=Videos;^qa-=Checks`). |

## Commands

- `/progress-bar`: bring back this session's bar after ✕, `/resume` or a restart.
- `/progress-bar check`: say in plain words which band is active and why.
