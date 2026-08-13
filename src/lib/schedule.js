// Extension included on purpose: exercised by `node scripts/test-schedule.mjs`,
// and Node will not resolve './format'.
import { iso, today } from './format.js'

// When a repeat next comes round.
//
// Arithmetic on a rule object, nothing else. No table is read here, no clock is
// consulted except through an argument, and every function is pure — which is
// what makes the whole thing testable from Node and what stops a bill quietly
// landing on the wrong date because a screen re-rendered.
//
// The rule shape, stored as jsonb / a plain object:
//
//   { every: 1, unit: 'month', monthDay: 5 }        the 5th, every month
//   { every: 1, unit: 'month', lastDay: true }      the last day of the month
//   { every: 2, unit: 'week', weekday: 0 }          every other Sunday
//   { every: 3, unit: 'day' }                       every third day
//   { every: 1, unit: 'year', monthDay: 15 }        once a year, on the start's month
//   …any of the above plus { until: '2027-03-31' }
//
// ponytail: no RRULE library. That is a calendar-app dependency — timezones,
// EXDATE, BYSETPOS, a parser — for what is four cadences and one clamp. What we
// do need and a naive version gets wrong is the month-end clamp: "the 31st,
// monthly" has to mean the 30th in April and the 28th in February, and it has
// to still mean the 31st in May rather than having drifted down to the 28th.
// That is why the month path recomputes from the anchor every time instead of
// stepping from the last occurrence.

export const UNITS = ['day', 'week', 'month', 'year']

export const WEEKDAYS = [
  [0, 'Sunday'], [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'],
  [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'],
]

const DATE = /^\d{4}-\d{2}-\d{2}$/

const D = (s) => {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d)
}

const addDaysTo = (date, n) => {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export const addDays = (isoDate, n) => iso(addDaysTo(D(isoDate), n))

/** Whole days from a to b, both ISO. Rounded, so a DST hour cannot make it .96. */
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000)

const daysInMonthOf = (y, m) => new Date(y, m + 1, 0).getDate()

/**
 * Is this a rule we can actually compute? Returns a sentence or null.
 *
 * Called on the way in from the form AND on the way out of the database. The
 * second is the one that matters: `rule` is jsonb, so a hand-edited row or a
 * backup file from a future version can put anything at all in it, and an
 * `every: 0` would be an infinite loop in a date walk rather than a wrong
 * number on a screen.
 */
export function ruleProblem(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'That repeat has no schedule.'
  if (!UNITS.includes(rule.unit)) return 'That repeat has an unknown cadence.'

  const every = Number(rule.every)
  if (!Number.isInteger(every) || every < 1 || every > 366) return 'Repeat every 1 to 366.'

  if (rule.weekday != null) {
    const w = Number(rule.weekday)
    if (!Number.isInteger(w) || w < 0 || w > 6) return 'That is not a day of the week.'
  }
  if (rule.monthDay != null) {
    const d = Number(rule.monthDay)
    if (!Number.isInteger(d) || d < 1 || d > 31) return 'A date in the month is 1 to 31.'
  }
  if (rule.until != null && !DATE.test(rule.until)) return 'That end date is not a date.'
  return null
}

/**
 * The first occurrence strictly after `after`, or null if the rule has run out.
 *
 * @param rule      see the shape above
 * @param startsOn  ISO date the repeat is anchored to. Every occurrence is
 *                  measured from here, never from the previous one — stepping
 *                  from the last occurrence is what makes a clamped month-end
 *                  ratchet downwards and never come back.
 * @param after     ISO date. Pass the day before `startsOn` to get the first
 *                  occurrence of all.
 */
export function nextOccurrence(rule, startsOn, after) {
  if (ruleProblem(rule)) return null
  if (!DATE.test(startsOn) || !DATE.test(after)) return null

  const hit = rule.unit === 'month' || rule.unit === 'year'
    ? byMonth(rule, startsOn, after)
    : byDay(rule, startsOn, after)

  if (!hit) return null
  if (rule.until && hit > rule.until) return null
  return hit
}

/** Days and weeks: one fixed stride, so the answer is division rather than a walk. */
function byDay(rule, startsOn, after) {
  const stride = rule.unit === 'week' ? rule.every * 7 : rule.every

  let base = D(startsOn)
  // "Every other Sunday" starting on a Wednesday means the Sunday after it, not
  // the Wednesday — the weekday names the occurrence, the start only says when
  // to begin looking.
  if (rule.unit === 'week' && rule.weekday != null) {
    base = addDaysTo(base, (Number(rule.weekday) - base.getDay() + 7) % 7)
  }

  const gap = daysBetween(iso(base), after)
  if (gap < 0) return iso(base)
  return iso(addDaysTo(base, (Math.floor(gap / stride) + 1) * stride))
}

/**
 * Months and years: recomputed from the anchor for each candidate month, then
 * the day clamped to that month's length.
 *
 * The 31st is the case worth stating. Anchored on 31 January, the occurrences
 * are 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May — the clamp applies for February
 * and April and then lets go. A version that stepped "one month" from the
 * previous occurrence would land on 28 Feb, then 28 Mar, and be wrong forever
 * after by a shrinking amount nobody notices until the rent is late.
 */
function byMonth(rule, startsOn, after) {
  const stride = (rule.unit === 'year' ? 12 : 1) * rule.every
  const base = D(startsOn)
  const wanted = rule.lastDay ? 'last' : Number(rule.monthDay ?? base.getDate())

  const at = (k) => {
    const y = base.getFullYear()
    const m = base.getMonth() + k * stride
    // Normalised by the Date constructor, so month 14 is February of next year.
    const probe = new Date(y, m, 1)
    const dim = daysInMonthOf(probe.getFullYear(), probe.getMonth())
    return iso(new Date(probe.getFullYear(), probe.getMonth(), wanted === 'last' ? dim : Math.min(wanted, dim)))
  }

  const a = D(after)
  // Close enough to land within a step or two, then corrected. Cheaper than
  // walking from the anchor, which for a yearly bill set up in 2019 is sixty
  // iterations every time a screen renders.
  let k = Math.floor(((a.getFullYear() - base.getFullYear()) * 12 + (a.getMonth() - base.getMonth())) / stride)
  if (k < 0) k = 0

  // Both walks are bounded. A rule that somehow escapes ruleProblem() must not
  // be able to spin here — it returns null and the caller shows nothing, which
  // is a missing reminder rather than a locked tab.
  let guard = 0
  while (k > 0 && at(k - 1) > after && guard++ < 480) k -= 1
  guard = 0
  while (at(k) <= after && guard++ < 480) k += 1
  if (guard >= 480) return null

  return at(k)
}

/**
 * When this template is next expected, given what it has already posted.
 *
 * A template that has never posted is due from its start date, so the "after"
 * is the day before it — otherwise a bill created on the 5th for the 5th would
 * skip a month before it ever fired once.
 */
export function nextDue(t, now = today()) {
  if (!t?.rule) return null
  const startsOn = DATE.test(t.starts_on ?? '') ? t.starts_on : (t.created_at ?? now).slice(0, 10)
  const after = DATE.test(t.last_posted_on ?? '') ? t.last_posted_on : addDays(startsOn, -1)
  return nextOccurrence(t.rule, startsOn, after)
}

/** Due today or overdue, and not paused. */
export function isDue(t, now = today()) {
  const next = nextDue(t, now)
  return Boolean(next) && next <= now
}

/**
 * Every date this template still owes on or before `to`, oldest first, capped.
 *
 * "Still owes" is measured from `last_posted_on`, so a bill confirmed on the 5th
 * owes nothing else this month, and a bill nobody has confirmed since June owes
 * June, July and August — three payments, not one.
 *
 * The horizon is an argument because two screens ask two different questions of
 * the same walk: what is due *now* (a list to confirm) and what is due *before
 * month end* (a figure to plan against).
 *
 * `from` narrows the walk to a window, and it moves the ANCHOR rather than
 * filtering the result — which is the whole point of it. Filtering afterwards
 * spends the cap on dates outside the window: a daily repeat anchored two years
 * ago returns two hundred dates from 2024 and none from the month being asked
 * about, so the figure comes back as zero with nothing on screen saying why.
 */
export function occurrencesDueBy(t, to, { from = null, cap = 200 } = {}) {
  const out = []
  if (!t?.rule) return out
  const startsOn = DATE.test(t.starts_on ?? '') ? t.starts_on : (t.created_at ?? to).slice(0, 10)
  let after = DATE.test(t.last_posted_on ?? '') ? t.last_posted_on : addDays(startsOn, -1)
  if (DATE.test(from ?? '')) {
    const floor = addDays(from, -1)
    if (after < floor) after = floor
  }
  while (out.length < cap) {
    const next = nextOccurrence(t.rule, startsOn, after)
    if (!next || next > to) break
    out.push(next)
    after = next
  }
  return out
}

/**
 * Everything a template owes as of today, oldest first, capped.
 *
 * A bill left unconfirmed for four months is four payments, not one — but it is
 * also very often a bill that stopped, so the cap keeps a forgotten yearly
 * subscription from posting a wall of rows on the day someone reopens the app.
 * The screen says how many it is offering.
 */
export function pendingOccurrences(t, now = today(), cap = 6) {
  return occurrencesDueBy(t, now, { cap })
}

/** Times a month this comes round, for "what am I committed to". A month is
 *  30.4 days, the same figure lib/recurring.js uses, so a detected subscription
 *  and the bill you promote it into cost the same on screen. */
export function occurrencesPerMonth(rule) {
  if (ruleProblem(rule)) return 0
  const per = { day: 30.4, week: 30.4 / 7, month: 1, year: 1 / 12 }[rule.unit]
  return per / rule.every
}

/**
 * Money arriving is never a commitment, whichever direction the type implies.
 * A salary set up as a repeat used to be counted as ₹80,000 a month owed.
 */
const NEVER_OWED = new Set(['income', 'refund', 'repaid'])
const isOutgoing = (t) => t.direction !== 'credit' && !NEVER_OWED.has(t.type)

/**
 * What is still owed inside a window. `{ total, count, unknown, overdue }`.
 *
 * Not the same number as committedPerMonth, and the difference is the point:
 * that one is an average over a whole cadence, this one counts actual dates in a
 * window. Rent on the 5th is ₹18,000 of every month and ₹0 of the 6th onwards.
 *
 * `from` is what makes it a window rather than a running tally, and leaving it
 * off is how this was wrong. The walk starts at `last_posted_on`, so a rent
 * nobody had confirmed since May reported three rents — ₹54,000 — under a line
 * that says "committed this month". Two of those belong to months that have
 * already been and gone, were very probably already paid, and were already
 * counted against *their* months' spending. Subtracting them from what is left
 * of this month is the same rupee taken twice.
 *
 * The ones before the window are not dropped in silence either: `overdue`
 * carries the count, and both screens already list them by name.
 *
 * Only expenses. Every "left this month" figure in this app is a budget minus
 * spendTotal (lib/format.js), and spendTotal counts `expense` and nothing else —
 * so an SIP or a move into an envelope subtracted from it would take money off a
 * figure that never had it. A repeat with no type stated is spending, matching
 * what a row with no type is treated as everywhere else.
 *
 * `unknown` is the bills that are genuinely due and have no agreed amount — the
 * maid, the vegetable bill. They cannot be added up and they must not be
 * silently dropped either, or the screen quietly understates the month and
 * calls it certainty. The caller names them.
 */
export function committedBetween(templates, to, { from = null, cap = 200 } = {}) {
  const out = { total: 0, count: 0, unknown: 0, overdue: 0 }
  for (const t of templates ?? []) {
    if (!t?.rule || t.hidden) continue
    if ((t.type ?? 'expense') !== 'expense' || !isOutgoing(t)) continue
    // Cheap: the walk stops at the window's first date, so this is one extra
    // occurrence computed per bill, not a second pass over the schedule.
    if (from && occurrencesDueBy(t, addDays(from, -1), { cap: 1 }).length > 0) out.overdue += 1
    const dates = occurrencesDueBy(t, to, { from, cap })
    if (dates.length === 0) continue
    if (t.amount == null || t.amount === '') {
      out.unknown += 1
      continue
    }
    out.total += Number(t.amount) * dates.length
    out.count += 1
  }
  return out
}

/**
 * What a set of bills costs in a month. Skips anything already finished.
 *
 * Wider than committedBetween on purpose: this is the Repeats screen's headline
 * for everything that goes out on a schedule, an SIP and an envelope transfer
 * included, because on that screen they are the point. Money coming *in* is
 * excluded from both — that is not a matter of scope, it is the wrong sign.
 */
export function committedPerMonth(templates, now = today()) {
  return templates.reduce((sum, t) => {
    if (!t.rule || t.hidden || !t.amount || !isOutgoing(t)) return sum
    if (t.rule.until && t.rule.until < now) return sum
    return sum + Number(t.amount) * occurrencesPerMonth(t.rule)
  }, 0)
}

const ORDINAL = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

const PLURAL = { day: 'days', week: 'weeks', month: 'months', year: 'years' }

/** The rule as a person would say it. Used on every row that has one. */
export function describeRule(rule) {
  if (ruleProblem(rule)) return 'No schedule'
  const { every, unit, weekday, monthDay, lastDay } = rule
  const cadence = every === 1 ? `Every ${unit}` : `Every ${every} ${PLURAL[unit]}`

  if (unit === 'week' && weekday != null) {
    return `${cadence} on ${WEEKDAYS[weekday][1]}`
  }
  if (unit === 'month' || unit === 'year') {
    if (lastDay) return `${cadence}, on the last day`
    if (monthDay != null) return `${cadence}, on the ${ORDINAL(monthDay)}`
  }
  return cadence
}
