// A repeat that fires on the wrong day is worse than one that does not fire at
// all: it posts money on a date you did not spend it, and the ledger is then
// wrong in a way no screen flags. So: assertions, no framework.
//
//   node scripts/test-schedule.mjs

import assert from 'node:assert/strict'
import {
  addDays, committedBetween, committedPerMonth, describeRule, isDue, nextDue, nextOccurrence,
  occurrencesDueBy, occurrencesPerMonth, pendingOccurrences, ruleProblem,
} from '../src/lib/schedule.js'
import { endOfMonth } from '../src/lib/format.js'

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('  ok  ', label)
}

const monthly = (monthDay) => ({ every: 1, unit: 'month', monthDay })

// ── Days and weeks ─────────────────────────────────────────────────────────

check('every day steps one day at a time', () => {
  assert.equal(nextOccurrence({ every: 1, unit: 'day' }, '2026-03-01', '2026-03-01'), '2026-03-02')
})

check('every third day lands on the stride, not the day after', () => {
  const rule = { every: 3, unit: 'day' }
  assert.equal(nextOccurrence(rule, '2026-03-01', '2026-02-28'), '2026-03-01')
  assert.equal(nextOccurrence(rule, '2026-03-01', '2026-03-01'), '2026-03-04')
  assert.equal(nextOccurrence(rule, '2026-03-01', '2026-03-03'), '2026-03-04')
  assert.equal(nextOccurrence(rule, '2026-03-01', '2026-03-04'), '2026-03-07')
})

check('a far-future "after" is answered in one hop, not by walking', () => {
  // Six years on from the anchor, the closed form has to land exactly on a
  // multiple of the stride rather than near it. 2020-01-01 + 313 weeks is
  // 2025-12-31, so the next one is a week after that.
  const hit = nextOccurrence({ every: 7, unit: 'day' }, '2020-01-01', '2026-01-01')
  assert.equal(hit, '2026-01-07')
})

check('a weekly rule with a weekday moves the anchor onto that weekday', () => {
  // 2026-03-04 is a Wednesday; the first Sunday after it is the 8th.
  const rule = { every: 1, unit: 'week', weekday: 0 }
  assert.equal(nextOccurrence(rule, '2026-03-04', '2026-03-03'), '2026-03-08')
  assert.equal(nextOccurrence(rule, '2026-03-04', '2026-03-08'), '2026-03-15')
})

check('every other week keeps the fortnight, not the week', () => {
  const rule = { every: 2, unit: 'week', weekday: 1 }
  const first = nextOccurrence(rule, '2026-03-04', '2026-03-03')
  assert.equal(first, '2026-03-09') // the Monday after the anchor
  assert.equal(nextOccurrence(rule, '2026-03-04', first), '2026-03-23')
})

// ── Months, and the clamp that everyone gets wrong ─────────────────────────

check('a monthly rule holds its date', () => {
  const rule = monthly(5)
  assert.equal(nextOccurrence(rule, '2026-01-05', '2026-01-05'), '2026-02-05')
  assert.equal(nextOccurrence(rule, '2026-01-05', '2026-02-05'), '2026-03-05')
})

check('the 31st clamps in short months and RECOVERS in long ones', () => {
  // The bug this exists to catch: stepping from the previous occurrence gives
  // 31 Jan → 28 Feb → 28 Mar → 28 Apr, and the rent is three days early
  // forever. Anchored arithmetic gives back the 31st the moment there is one.
  const rule = monthly(31)
  const start = '2026-01-31'
  assert.equal(nextOccurrence(rule, start, '2026-01-31'), '2026-02-28')
  assert.equal(nextOccurrence(rule, start, '2026-02-28'), '2026-03-31')
  assert.equal(nextOccurrence(rule, start, '2026-03-31'), '2026-04-30')
  assert.equal(nextOccurrence(rule, start, '2026-04-30'), '2026-05-31')
})

check('the 29th finds 29 February in a leap year', () => {
  const rule = monthly(29)
  assert.equal(nextOccurrence(rule, '2028-01-29', '2028-01-29'), '2028-02-29')
  // 2026 is not a leap year, so the same rule clamps to the 28th.
  assert.equal(nextOccurrence(rule, '2026-01-29', '2026-01-29'), '2026-02-28')
})

check('last day of the month means the last day, whatever it is', () => {
  const rule = { every: 1, unit: 'month', lastDay: true }
  assert.equal(nextOccurrence(rule, '2026-01-31', '2026-01-31'), '2026-02-28')
  assert.equal(nextOccurrence(rule, '2026-01-31', '2026-02-28'), '2026-03-31')
  assert.equal(nextOccurrence(rule, '2026-01-31', '2026-03-31'), '2026-04-30')
})

check('a quarterly rule is every 3 months, on the date', () => {
  const rule = { every: 3, unit: 'month', monthDay: 10 }
  assert.equal(nextOccurrence(rule, '2026-01-10', '2026-01-10'), '2026-04-10')
  assert.equal(nextOccurrence(rule, '2026-01-10', '2026-04-10'), '2026-07-10')
})

check('a yearly rule crosses the year boundary', () => {
  const rule = { every: 1, unit: 'year', monthDay: 15 }
  assert.equal(nextOccurrence(rule, '2026-03-15', '2026-03-15'), '2027-03-15')
  // Anchored years back: still exact, and answered without walking sixty steps.
  assert.equal(nextOccurrence(rule, '2019-03-15', '2026-06-01'), '2027-03-15')
})

check('an "after" before the start returns the start itself', () => {
  assert.equal(nextOccurrence(monthly(5), '2026-06-05', '2026-01-01'), '2026-06-05')
})

check('a rule past its end date returns nothing', () => {
  const rule = { every: 1, unit: 'month', monthDay: 5, until: '2026-04-30' }
  assert.equal(nextOccurrence(rule, '2026-01-05', '2026-03-05'), '2026-04-05')
  assert.equal(nextOccurrence(rule, '2026-01-05', '2026-04-05'), null)
})

// ── Rules that must never be computed ──────────────────────────────────────

check('a broken rule is refused rather than looped over', () => {
  for (const bad of [
    null, undefined, 'monthly', 42, [],
    { every: 0, unit: 'day' },
    { every: -1, unit: 'day' },
    { every: 1.5, unit: 'day' },
    { every: 400, unit: 'day' },
    { every: 1, unit: 'fortnight' },
    { every: 1, unit: 'week', weekday: 9 },
    { every: 1, unit: 'month', monthDay: 0 },
    { every: 1, unit: 'month', monthDay: 32 },
    { every: 1, unit: 'month', until: 'soon' },
  ]) {
    assert.ok(ruleProblem(bad), `expected a complaint for ${JSON.stringify(bad)}`)
    assert.equal(nextOccurrence(bad, '2026-01-01', '2026-01-01'), null)
  }
})

check('a malformed date is refused', () => {
  assert.equal(nextOccurrence(monthly(5), 'never', '2026-01-01'), null)
  assert.equal(nextOccurrence(monthly(5), '2026-01-01', 'never'), null)
})

// ── What a template owes ───────────────────────────────────────────────────

check('a template that has never posted is due from its start date', () => {
  const t = { rule: monthly(5), starts_on: '2026-03-05' }
  assert.equal(nextDue(t, '2026-03-01'), '2026-03-05')
  assert.equal(isDue(t, '2026-03-04'), false)
  assert.equal(isDue(t, '2026-03-05'), true)
})

check('posting moves it on to the next one', () => {
  const t = { rule: monthly(5), starts_on: '2026-03-05', last_posted_on: '2026-03-05' }
  assert.equal(nextDue(t, '2026-03-06'), '2026-04-05')
  assert.equal(isDue(t, '2026-03-06'), false)
})

check('a template with no rule is never due', () => {
  assert.equal(nextDue({ payee: 'Chai' }, '2026-03-05'), null)
  assert.equal(isDue({ payee: 'Chai' }, '2026-03-05'), false)
})

check('months left unconfirmed are owed, oldest first and capped', () => {
  const t = { rule: monthly(5), starts_on: '2026-01-05' }
  assert.deepEqual(pendingOccurrences(t, '2026-04-10'), [
    '2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05',
  ])
  // A yearly bill forgotten for a decade must not offer to post ten rows.
  const old = { rule: { every: 1, unit: 'day' }, starts_on: '2020-01-01' }
  assert.equal(pendingOccurrences(old, '2026-01-01').length, 6)
})

check('nothing is owed before the start date', () => {
  assert.deepEqual(pendingOccurrences({ rule: monthly(5), starts_on: '2026-09-05' }, '2026-03-01'), [])
})

// ── Words ──────────────────────────────────────────────────────────────────

check('a rule reads as a sentence', () => {
  assert.equal(describeRule(monthly(5)), 'Every month, on the 5th')
  assert.equal(describeRule(monthly(1)), 'Every month, on the 1st')
  assert.equal(describeRule(monthly(2)), 'Every month, on the 2nd')
  assert.equal(describeRule(monthly(3)), 'Every month, on the 3rd')
  assert.equal(describeRule(monthly(11)), 'Every month, on the 11th')
  assert.equal(describeRule(monthly(22)), 'Every month, on the 22nd')
  assert.equal(describeRule({ every: 1, unit: 'month', lastDay: true }), 'Every month, on the last day')
  assert.equal(describeRule({ every: 2, unit: 'week', weekday: 0 }), 'Every 2 weeks on Sunday')
  assert.equal(describeRule({ every: 3, unit: 'day' }), 'Every 3 days')
  assert.equal(describeRule({ every: 1, unit: 'day' }), 'Every day')
  assert.equal(describeRule({ every: 1, unit: 'fortnight' }), 'No schedule')
})

check('what a month of repeats costs', () => {
  const bills = [
    { amount: 18000, rule: monthly(5) },
    { amount: 649, rule: { every: 1, unit: 'month', monthDay: 7 } },
    { amount: 12000, rule: { every: 1, unit: 'year', monthDay: 1 } }, // 1000 a month
    { amount: 700, rule: { every: 1, unit: 'week', weekday: 0 } }, // ~3040 a month
    { amount: 5000, rule: monthly(9), hidden: true }, // dismissed, costs nothing
    { amount: 400, rule: null }, // a tile, not a bill
    { amount: 999, rule: { every: 1, unit: 'month', monthDay: 1, until: '2026-01-31' } }, // over
  ]
  assert.equal(Math.round(committedPerMonth(bills, '2026-08-13')), 22689)
})

check('occurrences a month follow the stride', () => {
  assert.equal(occurrencesPerMonth({ every: 1, unit: 'month' }), 1)
  assert.equal(occurrencesPerMonth({ every: 2, unit: 'month' }), 0.5)
  assert.equal(occurrencesPerMonth({ every: 12, unit: 'month' }), 1 / 12)
  assert.equal(occurrencesPerMonth({ every: 1, unit: 'year' }), 1 / 12)
  assert.equal(occurrencesPerMonth({ every: 1, unit: 'fortnight' }), 0)
})

check('addDays crosses a month and a year', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
})

// ── What is owed before a date, and what it costs ──────────────────────────
//
// "₹28,649 committed before the 31st" is a different question from "₹22,689 a
// month". The monthly figure is an average over a whole cadence; this one is a
// count of actual dates in a window, and rent on the 5th contributes nothing to
// it on the 6th.

check('the month end is the last day, February and leap years included', () => {
  assert.equal(endOfMonth(new Date(2026, 7, 13)), '2026-08-31')
  assert.equal(endOfMonth(new Date(2026, 1, 1)), '2026-02-28')
  assert.equal(endOfMonth(new Date(2028, 1, 1)), '2028-02-29')
  assert.equal(endOfMonth(new Date(2026, 3, 30)), '2026-04-30')
})

check('every date a bill still owes on or before a horizon', () => {
  const t = { rule: monthly(5), starts_on: '2026-08-05' }
  assert.deepEqual(occurrencesDueBy(t, '2026-08-31'), ['2026-08-05'])
  assert.deepEqual(occurrencesDueBy(t, '2026-10-31'), ['2026-08-05', '2026-09-05', '2026-10-05'])
  // The day before it starts owes nothing at all.
  assert.deepEqual(occurrencesDueBy(t, '2026-08-04'), [])
})

check('a bill already confirmed this month owes nothing more this month', () => {
  const t = { rule: monthly(5), starts_on: '2026-01-05', last_posted_on: '2026-08-05' }
  assert.deepEqual(occurrencesDueBy(t, '2026-08-31'), [])
  assert.deepEqual(occurrencesDueBy(t, '2026-09-30'), ['2026-09-05'])
})

check('months left unconfirmed are still owed, and counted once each', () => {
  // Rent unconfirmed since June. Three payments are outstanding on 31 August,
  // not one — and not four, which is what a walk that forgot to stop looks like.
  const t = { rule: monthly(5), starts_on: '2026-06-05' }
  assert.deepEqual(occurrencesDueBy(t, '2026-08-31'), ['2026-06-05', '2026-07-05', '2026-08-05'])
})

check('a bill that has ended owes nothing past its end date', () => {
  const t = { rule: { ...monthly(5), until: '2026-08-31' }, starts_on: '2026-08-05' }
  assert.deepEqual(occurrencesDueBy(t, '2026-12-31'), ['2026-08-05'])
})

check('a tile has no schedule and therefore owes nothing', () => {
  assert.deepEqual(occurrencesDueBy({ payee: 'Chai', amount: 20 }, '2026-12-31'), [])
})

check('a daily repeat is capped rather than allowed to run away', () => {
  const t = { rule: { every: 1, unit: 'day' }, starts_on: '2020-01-01' }
  assert.equal(occurrencesDueBy(t, '2026-08-31').length, 200)
  assert.equal(occurrencesDueBy(t, '2026-08-31', { cap: 5 }).length, 5)
})

check('a window moves the anchor, so the cap is not spent outside it', () => {
  // A daily repeat anchored in 2020 owes over two thousand dates. Asked for
  // August alone, a walk that filtered afterwards would burn all 200 of its cap
  // on 2020 and answer "nothing due in August" — a zero that looks like a fact.
  const t = { rule: { every: 1, unit: 'day' }, starts_on: '2020-01-01' }
  const august = occurrencesDueBy(t, '2026-08-31', { from: '2026-08-01' })
  assert.equal(august.length, 31)
  assert.equal(august[0], '2026-08-01')
  assert.equal(august.at(-1), '2026-08-31')
})

check('a window never reaches back past what has already been confirmed', () => {
  // Confirmed on the 5th. Asking about the whole month must not re-offer it
  // just because the window opens on the 1st.
  const t = { rule: monthly(5), starts_on: '2026-01-05', last_posted_on: '2026-08-05' }
  assert.deepEqual(occurrencesDueBy(t, '2026-08-31', { from: '2026-08-01' }), [])
})

check('what is committed between now and a date', () => {
  // Every bill here is up to date, so each contributes only the dates that
  // genuinely fall before the 31st. A bill with a backlog is the case below.
  const bills = [
    { amount: 18000, direction: 'debit', rule: monthly(5), starts_on: '2026-01-05', last_posted_on: '2026-07-05' },
    { amount: 649, direction: 'debit', rule: monthly(28), starts_on: '2026-01-28', last_posted_on: '2026-07-28' },
    // Falls on the 1st, already confirmed — this month is paid for.
    { amount: 2000, direction: 'debit', rule: monthly(1), starts_on: '2026-01-01', last_posted_on: '2026-08-01' },
    // Sundays: 16, 23, 30 August fall in the window. The 9th does not.
    { amount: 700, direction: 'debit', rule: { every: 1, unit: 'week', weekday: 0 }, starts_on: '2026-08-16' },
    // Renews in March, so it costs nothing before this month is out.
    { amount: 12000, direction: 'debit', rule: { every: 1, unit: 'year', monthDay: 1 }, starts_on: '2026-03-01', last_posted_on: '2026-03-01' },
    { amount: 5000, direction: 'debit', rule: monthly(9), starts_on: '2026-08-09', hidden: true },
    { amount: 400, direction: 'debit', rule: null }, // a tile
    // Salary. Money arriving is not a commitment.
    { amount: 80000, direction: 'credit', rule: monthly(30), starts_on: '2026-08-30' },
    // The maid. Real, due twice before month end, and there is no figure to add.
    { amount: null, direction: 'debit', rule: { every: 2, unit: 'week', weekday: 6 }, starts_on: '2026-08-15' },
  ]
  const c = committedBetween(bills, '2026-08-31')
  assert.equal(c.total, 18000 + 649 + 700 * 3)
  assert.equal(c.count, 3) // rent, the 28th, and the one that falls three Sundays
  assert.equal(c.unknown, 1) // the maid, named but not counted
})

check('only spending is committed, because only spending is what is left of a budget', () => {
  // Every "left this month" figure in the app is a budget minus spendTotal, and
  // spendTotal counts expenses and nothing else. A committed total that also
  // counted an SIP and a move into an envelope would be subtracted from a
  // figure that never included them — the free number would read low by the
  // whole of someone's savings, every month.
  const bills = [
    { amount: 18000, direction: 'debit', type: 'expense', rule: monthly(5), starts_on: '2026-08-05' },
    { amount: 10000, direction: 'debit', type: 'investment', rule: monthly(6), starts_on: '2026-08-06' },
    { amount: 20000, direction: 'debit', type: 'transfer', rule: monthly(7), starts_on: '2026-08-07' },
    { amount: 3000, direction: 'debit', type: 'lent', rule: monthly(8), starts_on: '2026-08-08' },
  ]
  const c = committedBetween(bills, '2026-08-31')
  assert.equal(c.total, 18000)
  assert.equal(c.count, 1)
})

check('a repeat with no type stated is spending, the same as a row with none', () => {
  const bills = [{ amount: 500, direction: 'debit', rule: monthly(5), starts_on: '2026-08-05' }]
  assert.equal(committedBetween(bills, '2026-08-31').total, 500)
})

check('a salary is not a commitment, whichever figure is asked for', () => {
  // Money arriving on the 30th every month. committedPerMonth counted it, so a
  // ledger with the salary set up as a repeat reported ₹80,000 a month of
  // commitments that were the opposite of one.
  const salary = [{ amount: 80000, direction: 'credit', type: 'income', rule: monthly(30) }]
  assert.equal(committedPerMonth(salary, '2026-08-13'), 0)
  assert.equal(committedBetween(salary, '2026-08-31').total, 0)
})

check('a bill nobody has confirmed for months is committed for every one of them', () => {
  // The honest answer and the uncomfortable one: rent unconfirmed since June is
  // three payments owed, and a figure that showed one would be understating the
  // month by ₹36,000. This is the unwindowed question — "what does this bill
  // still owe, all of it" — which is what the Due now list is built from.
  const behind = [{ amount: 18000, direction: 'debit', rule: monthly(5), starts_on: '2026-06-05' }]
  assert.equal(committedBetween(behind, '2026-08-31').total, 54000)
})

check('asked about one month, a backlog is counted apart from it', () => {
  // The same rent, asked the question the Today screen actually asks: what does
  // AUGUST cost. One rent, not three. June's and July's have been and gone —
  // they were very probably paid, and they were counted against their own
  // months, so subtracting them from what is left of August is the same rupee
  // taken twice. They are not swallowed either: `overdue` names them.
  const behind = [{ amount: 18000, direction: 'debit', rule: monthly(5), starts_on: '2026-06-05' }]
  const c = committedBetween(behind, '2026-08-31', { from: '2026-08-01' })
  assert.equal(c.total, 18000)
  assert.equal(c.count, 1)
  assert.equal(c.overdue, 1)
})

check('a bill that is up to date is not reported as overdue', () => {
  const fine = [
    { amount: 18000, direction: 'debit', rule: monthly(5), starts_on: '2026-01-05', last_posted_on: '2026-07-05' },
  ]
  const c = committedBetween(fine, '2026-08-31', { from: '2026-08-01' })
  assert.equal(c.total, 18000)
  assert.equal(c.overdue, 0)
})

check('nothing scheduled is nothing committed, not a broken figure', () => {
  const none = { total: 0, count: 0, unknown: 0, overdue: 0 }
  assert.deepEqual(committedBetween([], '2026-08-31'), none)
  assert.deepEqual(committedBetween(null, '2026-08-31'), none)
})

console.log(`\n${passed} checks passed`)
