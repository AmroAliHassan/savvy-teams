// Route A "One surface" (0.8.0): the job header and the list card, drawn to a
// design that was reviewed for contrast and rhythm before it was built. Every word is inside a drawing; every
// control is the app's own secondary button beside it. Times show to the
// minute, so a drawing changes at most once a minute and its slow motion (the
// header's breathing dot, the current-step relay on a 6 s loop) never jumps.

export const ROW_H = 35
const R = 8
export const GAP = 8
/** The app's secondary buttons, measured on the live app (Goodnight, Hold for me) or estimated from the same font. */
export const BTN: Record<string, number> = { Goodnight: 111, 'Hold for me': 118, 'Claude decides': 144, Goodmorning: 137, Cancel: 78, Agents: 80, '✕': 40 }
/** Slack so a pixel or two of button-width error lands in a gap, never past the band edge. */
const SLACK = 4
export const drawingWidth = (cw: number, labels: string[]): number =>
  Math.max(240, Math.floor(cw - labels.reduce((s, l) => s + (BTN[l] ?? 90) + GAP, 0) - SLACK))

const FONT = "'Segoe UI', system-ui, sans-serif"
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
/** Text width in Segoe UI, estimated (the hooks have no canvas to measure with). */
export const tw = (t: string, size = 14, weight = 400): number => t.length * size * (weight >= 600 ? 0.555 : 0.515)
export const fit = (t: string, max: number, size: number, weight = 400): string => {
  if (tw(t, size, weight) <= max) return t
  let s = t
  while (s.length > 1 && tw(s + '…', size, weight) > max) s = s.slice(0, -1)
  return s.trimEnd() + '…'
}
const T = (x: number, y: number, s: string, o: { size?: number; w?: number; fill?: string; anchor?: string } = {}): string =>
  `<text x="${x.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 14}" font-weight="${o.w ?? 400}" fill="${o.fill ?? '#fff'}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} style="font-variant-numeric:tabular-nums">${esc(s)}</text>`
const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

export type Theme = { surf: string; stroke: string; text: string; sub: string; mute: string; track: string; run: string; rev: string; acc: string; fail: string; wait: string; glyphInk: string }
export const THEME: Record<'dark' | 'light', Theme> = {
  dark: { surf: '#2C2C2B', stroke: '#3A3A38', text: '#F2F1EE', sub: '#A3A3A0', mute: '#C8C8C4', track: '#3F3F3D', run: '#38BDF8', rev: '#FB923C', acc: '#2DD4BF', fail: '#FB7185', wait: '#94A3B8', glyphInk: '#1B1B1A' },
  light: { surf: '#FFFFFF', stroke: '#E2DED5', text: '#1F1F1E', sub: '#6B6A66', mute: '#57564F', track: '#E9E6DF', run: '#0369A1', rev: '#C2410C', acc: '#0F766E', fail: '#BE123C', wait: '#475569', glyphInk: '#FFFFFF' },
}
const CHIP: Record<string, string> = { Working: '#0369A1', Review: '#C2410C', Done: '#0F766E', Planning: '#475569', Design: '#475569', Closing: '#0F766E' }

/**
 * The last drawing made for each slot, with a fingerprint of its inputs. The band
 * is drawn about once a second while agents run, but its drawings change at most
 * once a minute (times are minutes), so a redraw reuses the same string.
 */
const lastDrawn = new Map<string, { key: string; svg: string }>()
export const remembered = (slot: string, key: string, draw: () => string): string => {
  const hit = lastDrawn.get(slot)
  if (hit && hit.key === key) return hit.svg
  const svg = draw()
  lastDrawn.set(slot, { key, svg })
  return svg
}

/** Minutes only: "<1m", "22m", "1h 58m". */
export const fmtMin = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60000)
  if (m < 1) return '<1m'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export type AState = 'run' | 'rev' | 'acc' | 'fail' | 'wait'
export type ATask = { title: string; agent: string; s: AState; done: number; total: number; minutes: string; note?: string }
export type AJob = { title: string; phase: string; accepted: number; total: number; elapsed: string; cells: AState[] }

const glyph = (s: AState, x: number, y: number, C: Theme): string => {
  if (s === 'run') return `<circle cx="${x}" cy="${y}" r="5.5" fill="none" stroke="${C.run}" stroke-width="1.6"/><circle cx="${x}" cy="${y}" r="2" fill="${C.run}"/>`
  if (s === 'rev') return `<rect x="${x - 4.6}" y="${y - 4.6}" width="9.2" height="9.2" rx="1.6" transform="rotate(45 ${x} ${y})" fill="${C.rev}"/>`
  if (s === 'acc') return `<circle cx="${x}" cy="${y}" r="6.5" fill="${C.acc}"/><path d="M${x - 3} ${y + 0.2} l2.1 2.1 l4 -4.2" fill="none" stroke="${C.glyphInk}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
  if (s === 'fail') return `<circle cx="${x}" cy="${y}" r="6.5" fill="${C.fail}"/><path d="M${x - 2.4} ${y - 2.4} l4.8 4.8 M${x + 2.4} ${y - 2.4} l-4.8 4.8" stroke="${C.glyphInk}" stroke-width="1.7" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5.5" fill="none" stroke="${C.wait}" stroke-width="1.5" stroke-dasharray="2.2 2.2"/>`
}

/** One cell per task: accepted, review, running, failed, the rest dim. */
const meter = (x: number, y: number, w: number, h: number, cells: AState[], C: Theme): string => {
  const n = Math.max(1, cells.length)
  const gap = n > 40 ? 0.8 : 1.5
  const cw = (w - gap * (n - 1)) / n
  return cells
    .map((s, i) => {
      const fill = s === 'acc' ? C.acc : s === 'rev' ? C.rev : s === 'run' ? C.run : s === 'fail' ? C.fail : C.sub
      return `<rect x="${(x + i * (cw + gap)).toFixed(2)}" y="${y}" width="${Math.max(0.6, cw).toFixed(2)}" height="${h}" rx="1" fill="${fill}" fill-opacity="${s === 'wait' ? 0.35 : 1}"/>`
    })
    .join('')
}

/** The job header: one panel, a breathing live dot, title, phase chip, "N of M accepted", the meter and the elapsed minutes. */
export const headerSvg = (w: number, job: AJob, C: Theme): string => {
  const isDone = job.phase === 'Done'
  const dot = isDone ? C.acc : job.phase === 'Review' ? C.rev : C.run
  let b = `<rect x=".5" y=".5" width="${w - 1}" height="${ROW_H - 1}" rx="${R - 0.5}" fill="${C.surf}" stroke="${C.stroke}"/>`
  b += `<circle cx="17" cy="17.5" r="4" fill="${dot}"/>`
  if (!isDone) b += `<circle cx="17" cy="17.5" r="4" fill="none" stroke="${dot}" stroke-width="1.5"><animate attributeName="r" values="4;9;9" keyTimes="0;.6;1" dur="2.4s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values=".7;0;0" keyTimes="0;.6;1" dur="2.4s" repeatCount="indefinite"/></circle>`
  const right = `${job.accepted} of ${job.total} accepted`
  const tx = w - 14
  const mw = Math.min(150, Math.max(60, w * 0.18))
  const mx = tx - tw(job.elapsed, 13) - 16 - mw
  const rightStart = mx - 12 - tw(right, 13)
  const chipW = tw(job.phase, 12, 600) + 18
  const title = fit(job.title, Math.min(330, rightStart - 32 - 12 - chipW - 16), 14, 600)
  b += T(32, 22.5, title, { w: 600, fill: C.text })
  const cx = 32 + tw(title, 14, 600) + 12
  b += `<rect x="${cx.toFixed(1)}" y="8.5" width="${chipW.toFixed(1)}" height="18" rx="9" fill="${CHIP[job.phase] ?? '#475569'}"/>` + T(cx + 9, 21.5, job.phase, { size: 12, w: 600 })
  b += T(tx, 22.5, job.elapsed, { size: 13, fill: C.mute, anchor: 'end' })
  b += meter(mx, 14.5, mw, 6, job.cells, C)
  b += T(mx - 12, 22.5, right, { size: 13, fill: C.text, anchor: 'end' })
  return svg(w, ROW_H, b)
}

/** The step track: one segment per step; the current step breathes, one row at a time on a shared 6 s clock. */
const track = (x: number, y: number, w: number, h: number, t: ATask, C: Theme, i: number, col: string): string => {
  const n = Math.max(1, t.total)
  const g = 2
  const sw = (w - g * (n - 1)) / n
  let s = ''
  for (let k = 0; k < n; k++) {
    const X = (x + k * (sw + g)).toFixed(2)
    if (k < t.done) s += `<rect x="${X}" y="${y}" width="${sw.toFixed(2)}" height="${h}" rx="${h / 2}" fill="${col}"/>`
    else if (k === t.done && t.s === 'run') {
      const a = (i % 4) * 0.25
      s += `<rect x="${X}" y="${y}" width="${sw.toFixed(2)}" height="${h}" rx="${h / 2}" fill="${col}" fill-opacity=".5"><animate attributeName="fill-opacity" values=".5;.5;.9;.5;.5" keyTimes="0;${a};${a + 0.125};${Math.min(a + 0.25, 1)};1" dur="6s" repeatCount="indefinite"/></rect>`
    } else s += `<rect x="${X}" y="${y}" width="${sw.toFixed(2)}" height="${h}" rx="${h / 2}" fill="${C.track}"/>`
  }
  return s
}

export const cardHeight = (rows: number, hasMore: boolean, hasNames: boolean): number =>
  4 + (hasNames ? 23 : 0) + 24 * rows + (hasMore ? 1 + 18 : 0) + 4

/**
 * The list card: the accepted fold (whole names, then +N), up to four live rows
 * on fixed columns (glyph, task, agent, step track, steps or state word,
 * minutes) and "+N more". Widths follow the band; the columns scale with it.
 */
export const cardSvg = (w: number, accepted: number, names: string[], tasks: ATask[], more: { n: number; note: string } | null, C: Theme): { svg: string; h: number } => {
  const hasNames = accepted > 0
  const h = cardHeight(tasks.length, !!more, hasNames)
  let b = `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${R - 0.5}" fill="${C.surf}" stroke="${C.stroke}"/>`
  let y0 = 4
  if (hasNames) {
    const y = y0 + 11
    b += glyph('acc', 17, y, C)
    const lab = `${accepted} accepted`
    b += T(32, y + 4.8, lab, { size: 13, w: 600, fill: C.acc })
    const x = 32 + tw(lab, 13, 600) + 14
    const room = w - 14 - x
    const shown: string[] = []
    for (const nm of names) {
      const rest = names.length - shown.length - 1
      if (tw([...shown, nm].join('  ·  ') + (rest > 0 ? `  ·  +${rest}` : ''), 13) > room) break
      shown.push(nm)
    }
    const rest = accepted - shown.length
    b += T(x, y + 4.8, shown.join('  ·  ') + (rest > 0 ? `${shown.length ? '  ·  ' : ''}+${rest}` : ''), { size: 13, fill: C.sub })
    y0 += 22
    if (tasks.length) b += `<line x1="12" x2="${w - 12}" y1="${y0 + 0.5}" y2="${y0 + 0.5}" stroke="${C.stroke}"/>`
    y0 += 1
  }
  const X = { glyph: 17, title: 32, agent: Math.round(w * 0.351), track: Math.round(w * 0.543), trackW: Math.round(w * 0.266), steps: Math.round(w * 0.828), time: w - 14 }
  tasks.forEach((t, i) => {
    const cy = y0 + 24 * i + 12
    const by = cy + 4.8
    b += glyph(t.s, X.glyph, cy, C)
    b += T(X.title, by, fit(t.title, X.agent - X.title - 18, 13.5, 600), { size: 13.5, w: 600, fill: C.text })
    b += T(X.agent, by, fit(t.agent, X.track - X.agent - 15, 13), { size: 13, fill: C.sub })
    const col = t.s === 'run' ? C.run : t.s === 'rev' ? C.rev : t.s === 'fail' ? C.fail : C.wait
    b += track(X.track, cy - 2, X.trackW, 4, t, C, i, col)
    const word =
      t.s === 'run' ? (t.total ? `${t.done}/${t.total}` : 'working')
      : t.s === 'rev' ? 'ready for review'
      : t.s === 'fail' ? (t.total ? `failed at step ${t.done + 1}` : 'failed')
      : t.note ?? 'waiting'
    b += T(X.steps, by, fit(word, X.time - X.steps - 26, 13, t.s === 'wait' ? 400 : 600), { size: 13, w: t.s === 'wait' ? 400 : 600, fill: t.s === 'run' ? C.text : col })
    if (t.minutes) b += T(X.time, by, t.minutes, { size: 13, fill: C.mute, anchor: 'end' })
  })
  if (more) {
    const ly = y0 + 24 * tasks.length
    b += `<line x1="12" x2="${w - 12}" y1="${ly + 0.5}" y2="${ly + 0.5}" stroke="${C.stroke}"/>`
    const my = ly + 1 + 9 + 4.6
    const lab = `+${more.n} more`
    b += T(X.title, my, lab, { size: 13, w: 600, fill: C.mute })
    b += T(X.title + tw(lab, 13, 600) + 12, my, fit(more.note, w - 60 - tw(lab, 13, 600), 13), { size: 13, fill: C.sub })
  }
  return { svg: svg(w, h, b), h }
}
