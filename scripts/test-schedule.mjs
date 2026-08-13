// A repeat that fires on the wrong day is worse than one that does not fire at
// all: it posts money on a date you did not spend it, and the ledger is then
// wrong in a way no screen flags. So: assertions, no framework.
//
//   node scripts/test-schedule.mjs

import assert from 'node:assert/strict'
import {
  addDays, committedPerMonth, describeRule, isDue, nextDue, nextOccurrence, occurrencesPerMonth,
  pendingOccurrences, ruleProblem,
} from '../src/lib/schedule.js'

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

console.log(`\n${passed} checks passed`)
