import { iso, today } from './format.js'

// Day / week / month / custom, plus stepping backwards and forwards through
// them. All arithmetic is on local Date objects and returns ISO strings, so it
// never drifts a day the way toISOString() does.

export const MODES = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['custom', 'Custom'],
]

const D = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const add = (s, days) => {
  const d = D(s)
  d.setDate(d.getDate() + days)
  return iso(d)
}

/** Monday-first, which is how a spending week actually reads in India. */
const weekStart = (s) => {
  const d = D(s)
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return iso(d)
}

const DAY_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })
const DAY_YEAR_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
const MONTH_FMT = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' })
const MONTH_SHORT = new Intl.DateTimeFormat('en-IN', { month: 'long' })

const thisYear = (s) => Number(s.slice(0, 4)) === new Date().getFullYear()

/** { from, to, label } for a mode anchored on a date. */
export function makeRange(mode, anchor, custom) {
  if (mode === 'custom') {
    const from = custom?.from || anchor
    const to = custom?.to || anchor
    // Two dates picked in the wrong order is a slip, not an empty range.
    const [a, b] = from <= to ? [from, to] : [to, from]
    return { from: a, to: b, label: `${DAY_FMT.format(D(a))} – ${DAY_YEAR_FMT.format(D(b))}` }
  }

  if (mode === 'day') {
    const label = anchor === today() ? 'Today' : DAY_YEAR_FMT.format(D(anchor))
    return { from: anchor, to: anchor, label }
  }

  if (mode === 'week') {
    const from = weekStart(anchor)
    const to = add(from, 6)
    const now = weekStart(today())
    if (from === now) return { from, to, label: 'This week' }
    if (from === add(now, -7)) return { from, to, label: 'Last week' }
    return { from, to, label: `${DAY_FMT.format(D(from))} – ${DAY_YEAR_FMT.format(D(to))}` }
  }

  // month
  const d = D(anchor)
  const from = iso(new Date(d.getFullYear(), d.getMonth(), 1))
  const to = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0))
  const label = thisYear(from) ? MONTH_SHORT.format(D(from)) : MONTH_FMT.format(D(from))
  return { from, to, label }
}

/** Move the anchor one period in `dir` (-1 back, +1 forward). */
export function step(mode, anchor, dir) {
  if (mode === 'day') return add(anchor, dir)
  if (mode === 'week') return add(weekStart(anchor), dir * 7)
  const d = D(anchor)
  return iso(new Date(d.getFullYear(), d.getMonth() + dir, 1))
}

/** True once stepping forward would land entirely in the future — the button
 *  that does nothing is worse than the button that isn't there. */
export const atLatest = (mode, anchor) =>
  mode === 'custom' || makeRange(mode, step(mode, anchor, 1)).from > today()
