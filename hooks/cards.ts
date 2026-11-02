// The Agents panel, black and white (0.6.0; kept in 0.8): savvy-progress's panel of
// runs redrawn as plain cards with ink progress bars, coral only for a failure.

const FONT = `font-family="'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif"`
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
/** Cuts text to about `px` wide at `size` px, with an ellipsis. */
export const fit = (t: string, px: number, size: number): string => {
  const per = size * 0.53
  return t.length * per > px ? t.slice(0, Math.max(1, Math.floor(px / per) - 1)) + '…' : t
}
const svg = (W: number, H: number, defs: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`

// --- the Agents panel: black and white -----------------------------------------
// The user asked for a calm panel (2 Nov 2026): neutral cards, ink progress bars,
// no colour but one small coral mark when an agent failed, so a failure stands out.

export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '-'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}
export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`)
export const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

/** The panel's ink for the person's theme: one card surface, one ink, one dim. */
export type Tone = { card: string; line: string; ink: string; dim: string; track: string }
export const toneOf = (isLight: boolean): Tone =>
  isLight
    ? { card: '#F2F0EB', line: '#DEDBD3', ink: '#1C1B19', dim: '#76736B', track: '#DEDBD3' }
    : { card: '#2A2A28', line: '#3A3A37', ink: '#F2F0EB', dim: '#9B988F', track: '#454541' }

/** The panel's head: the job's name, then three plain tiles (cost, tokens, time). */
export const paneHeader = (W: number, t: Tone, title: string, cost: string, tokens: string, time: string): string => {
  const top = title ? 30 : 0
  const H = top + 58
  const gap = 8
  const tw = (W - gap * 2) / 3
  const tile = (i: number, label: string, value: string) =>
    `<g transform="translate(${(i * (tw + gap)).toFixed(1)} ${top})"><rect x=".5" y=".5" width="${(tw - 1).toFixed(1)}" height="53" rx="11" fill="${t.card}" stroke="${t.line}"/>` +
    `<text x="12" y="20" ${FONT} font-size="11.5" fill="${t.dim}">${label}</text>` +
    `<text x="12" y="42" ${FONT} font-size="17" font-weight="700" fill="${t.ink}">${esc(fit(value, tw - 20, 17))}</text></g>`
  return svg(W, H, '',
    (title ? `<text x="2" y="20" ${FONT} font-size="15" font-weight="700" fill="${t.ink}">${esc(fit(title, W - 8, 15))}</text>` : '') +
    tile(0, 'Cost', cost) + tile(1, 'Tokens', tokens) + tile(2, 'Time', time))
}

export type PaneAgent = {
  description: string
  type: string
  model: string
  effort?: string
  status: 'running' | 'done' | 'failed'
  round?: number
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  contextTokens?: number
  contextMax?: number
  tokens?: number
  costUsd?: number
  /** Its time, as the panel shows it. */
  time: string
}
export const AGENT_H = 72
const initials = (type: string): string =>
  type.replace(/^[^:]*:/, '').split(/[-_\s]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
/** One agent as a plain card: initials, name, model, step and note, context, tokens, cost, and an ink progress bar. */
export const agentCard = (W: number, t: Tone, a: PaneAgent): string => {
  const H = AGENT_H
  const frac = a.stepTotal ? Math.min(1, (a.stepDone ?? 0) / a.stepTotal) : a.status === 'running' ? 0 : 1
  const ctx = a.contextMax ? Math.round(((a.contextTokens ?? 0) / a.contextMax) * 100) : null
  const sub = [a.type.replace(/^[^:]*:/, ''), modelName(a.model), a.effort, a.round && a.round > 1 ? `round ${a.round}` : ''].filter(Boolean).join(' · ')
  const step = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ` · ${a.stepNote}` : ''}` : a.status === 'running' ? 'working' : a.status === 'failed' ? 'failed' : 'finished'
  const right = [ctx === null ? '' : `ctx ${ctx}%`, a.tokens ? fmtTokens(a.tokens) : '', a.costUsd ? `≈${fmtCost(a.costUsd)}` : ''].filter(Boolean).join(' · ')
  const isLive = a.status === 'running'
  const state =
    a.status === 'failed'
      ? `<g transform="translate(${W - 26} 8)"><circle cx="7" cy="7" r="6.5" fill="${'#E63946'}"/><path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>`
      : a.status === 'done'
        ? `<g transform="translate(${W - 26} 8)"><path d="M2.5 7.5l3 3 6-6.5" fill="none" stroke="${t.dim}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`
        : `<circle cx="${W - 19}" cy="15" r="3.5" fill="${t.ink}"/>`
  return svg(W, H, '',
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.card}" stroke="${t.line}"/>` +
    `<circle cx="26" cy="26" r="14.5" fill="none" stroke="${isLive ? t.ink : t.dim}" stroke-width="1.3"/><text x="26" y="30.5" text-anchor="middle" ${FONT} font-size="11.5" font-weight="700" fill="${isLive ? t.ink : t.dim}">${esc(initials(a.type))}</text>` +
    `<text x="50" y="21" ${FONT} font-size="13.5" font-weight="650" fill="${isLive ? t.ink : t.dim}">${esc(fit(a.description, W - 50 - 84, 13.5))}</text>` +
    `<text x="${W - 32}" y="21" text-anchor="end" ${FONT} font-size="12" font-weight="600" fill="${t.ink}">${esc(a.time)}</text>` +
    state +
    `<text x="50" y="38" ${FONT} font-size="11.5" fill="${t.dim}">${esc(fit(sub, W - 62, 11.5))}</text>` +
    `<text x="50" y="55" ${FONT} font-size="11.5" font-weight="600" fill="${isLive ? t.ink : t.dim}">${esc(fit(step, W * 0.5, 11.5))}</text>` +
    `<text x="${W - 12}" y="55" text-anchor="end" ${FONT} font-size="11" fill="${t.dim}">${esc(right)}</text>` +
    `<rect x="12" y="62" width="${W - 24}" height="4" rx="2" fill="${t.track}"/><rect x="12" y="62" width="${Math.max(4, (W - 24) * frac).toFixed(1)}" height="4" rx="2" fill="${a.status === 'failed' ? '#E63946' : isLive ? t.ink : t.dim}"/>`)
}

export const PLANNED_H = 40
/** A task the plan shows as accepted, with no run in this session to show (after a restart): a plain card with a tick. */
export const acceptedCard = (W: number, t: Tone, n: number, title: string): string =>
  svg(W, PLANNED_H, '',
    `<rect x=".5" y=".5" width="${W - 1}" height="${PLANNED_H - 1}" rx="11" fill="${t.card}" stroke="${t.line}"/>` +
    `<g transform="translate(12 12)"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="${t.dim}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    `<text x="38" y="25" ${FONT} font-size="12.5" font-weight="600" fill="${t.dim}">${esc(fit(`${n}. ${title}`, W - 60, 12.5))}</text>`)
/** A planned task not started yet: a dashed outline. */
export const plannedCard = (W: number, t: Tone, n: number, title: string, after: string): string => {
  const H = PLANNED_H
  return svg(W, H, '',
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="11" fill="none" stroke="${t.line}" stroke-dasharray="4 3"/>` +
    `<g transform="translate(12 12)"><circle cx="8" cy="8" r="6.2" fill="none" stroke="${t.dim}" stroke-width="1.4" stroke-dasharray="2.3 2.2"/></g>` +
    `<text x="38" y="25" ${FONT} font-size="12.5" font-weight="600" fill="${t.dim}">${esc(fit(`${n}. ${title}`, W - 160, 12.5))}</text>` +
    `<text x="${W - 12}" y="25" text-anchor="end" ${FONT} font-size="11.5" fill="${t.dim}">${esc(after)}</text>`)
}
