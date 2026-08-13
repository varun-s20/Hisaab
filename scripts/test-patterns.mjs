// The tile detector decides what gets a one-tap button that WRITES A PAYMENT.
// Too loose and a stall you visited once becomes a button you can fat-finger
// into your ledger; too tight and the feature never appears. Both failures are
// silent, so: assertions, no framework.
//
//   node scripts/test-patterns.mjs

import assert from 'node:assert/strict'
import { findFrequent, findRecurring } from '../src/lib/recurring.js'

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('  ok  ', label)
}

const NOW = '2026-08-13'

const txn = (payee, date, amount, extra = {}) => ({
  payee_clean: payee,
  payee_raw: payee.toUpperCase(),
  txn_date: date,
  amount,
  type: 'expense',
  category: 'Food',
  ...extra,
})

/** n sightings of the same thing, one every `gap` days working backwards. */
const repeat = (payee, amount, n, { from = NOW, gap = 3, ...extra } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(from) - i * gap * 86400000)
    return txn(payee, d.toISOString().slice(0, 10), amount, extra)
  })

check('four sightings at one price becomes a one-tap tile', () => {
  const [tile, ...rest] = findFrequent(repeat('Chai', 20, 4), { now: NOW })
  assert.equal(rest.length, 0)
  assert.equal(tile.payee, 'Chai')
  assert.equal(tile.amount, 20)
  assert.equal(tile.exact, true)
  assert.equal(tile.count, 4)
})

check('three sightings is not enough — one chai from a stall is not a habit', () => {
  assert.deepEqual(findFrequent(repeat('Chai', 20, 3), { now: NOW }), [])
  assert.deepEqual(findFrequent([txn('Some Stall', NOW, 20)], { now: NOW }), [])
})

check('sightings outside the window do not count towards the four', () => {
  // Four visits, but spread 40 days apart, so only two are inside sixty days.
  assert.deepEqual(findFrequent(repeat('Chai', 20, 4, { gap: 40 }), { now: NOW }), [])
})

check('a merchant with scattered prices is offered without one', () => {
  const rows = [
    txn('Blinkit', '2026-08-12', 240),
    txn('Blinkit', '2026-08-09', 1900),
    txn('Blinkit', '2026-08-05', 615),
    txn('Blinkit', '2026-08-01', 430),
  ]
  const [tile] = findFrequent(rows, { now: NOW })
  assert.equal(tile.payee, 'Blinkit')
  assert.equal(tile.exact, false, 'four different prices must not become a one-tap amount')
})

check('the tile carries the commonest price, not the latest', () => {
  const rows = [
    txn('Auto', '2026-08-13', 150), // today, and an outlier
    txn('Auto', '2026-08-11', 80),
    txn('Auto', '2026-08-09', 80),
    txn('Auto', '2026-08-07', 80),
    txn('Auto', '2026-08-05', 80),
  ]
  const [tile] = findFrequent(rows, { now: NOW })
  assert.equal(tile.amount, 80)
  assert.equal(tile.exact, true)
})

check('the tile carries the commonest category, method and account', () => {
  const rows = [
    ...repeat('Sabzi', 60, 3, { method: 'cash', account: 'Wallet', category: 'Groceries' }),
    txn('Sabzi', '2026-08-01', 60, { method: 'gpay', account: 'HDFC', category: 'Food' }),
  ]
  const [tile] = findFrequent(rows, { now: NOW })
  assert.equal(tile.category, 'Groceries')
  assert.equal(tile.method, 'cash')
  assert.equal(tile.account, 'Wallet')
})

check('income, transfers and investments are never tiles', () => {
  for (const type of ['income', 'transfer', 'investment', 'lent', 'refund', 'repaid']) {
    assert.deepEqual(findFrequent(repeat('Salary', 80000, 6, { type }), { now: NOW }), [], type)
  }
})

check('rows with no amount or no name are ignored', () => {
  assert.deepEqual(findFrequent(repeat('Chai', null, 6), { now: NOW }), [])
  assert.deepEqual(
    findFrequent(repeat('x', 20, 6).map((r) => ({ ...r, payee_clean: null, payee_raw: null })), { now: NOW }),
    [],
  )
})

check('the most-used comes first, ties broken by which is more recent', () => {
  const rows = [
    ...repeat('Chai', 20, 6),
    ...repeat('Auto', 80, 4),
    ...repeat('Milk', 30, 4, { from: '2026-08-01' }),
  ]
  assert.deepEqual(findFrequent(rows, { now: NOW }).map((t) => t.payee), ['Chai', 'Auto', 'Milk'])
})

check('an empty ledger produces no tiles rather than throwing', () => {
  assert.deepEqual(findFrequent([], { now: NOW }), [])
})

// ── The subscription detector must not have changed ────────────────────────
// findFrequent was folded into the same grouping, so this is the guard on that
// refactor rather than new coverage.

check('a steady monthly charge is still recurring, and now names its method', () => {
  const found = findRecurring([
    txn('Netflix', '2026-06-07', 649, { method: 'card', account: 'HDFC card' }),
    txn('Netflix', '2026-07-07', 649, { method: 'card', account: 'HDFC card' }),
    txn('Netflix', '2026-08-07', 649, { method: 'card', account: 'HDFC card' }),
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].cadence, 'monthly')
  assert.equal(found[0].amount, 649)
  assert.equal(found[0].method, 'card')
  assert.equal(found[0].account, 'HDFC card')
  assert.equal(found[0].next, '2026-09-06')
})

check('four chais in a fortnight are a tile and NOT a subscription', () => {
  const rows = repeat('Chai', 20, 4)
  assert.equal(findFrequent(rows, { now: NOW }).length, 1)
  assert.equal(findRecurring(rows).length, 0, 'a 3-day habit is not a bill')
})

console.log(`\n${passed} checks passed`)
