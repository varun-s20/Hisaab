// The one runnable check. `node scripts/test-parse.mjs`
// Covers the parser failures that would silently corrupt the ledger:
// Indian comma grouping, day-first dates, direction, personal detection.

import assert from 'node:assert/strict'
import {
  parse, toNumber, extractDate, extractDirection, extractPayee,
  isPersonal, detectApp, synthRef,
} from '../src/lib/parse.js'

const NOW = new Date(2026, 7, 11) // 11 Aug 2026
let n = 0
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`) }

check('Indian grouping does not become 1', () => {
  assert.equal(toNumber('1,00,000'), 100000)
  assert.equal(toNumber('12,345.67'), 12345.67)
  assert.equal(toNumber('₹ 1,20,500'), null) // currency mark is stripped upstream
})

check('day-first dates', () => {
  assert.equal(extractDate('paid on 03/04/26', NOW), '2026-04-03') // 3 Apr, not 4 Mar
  assert.equal(extractDate('12 Aug 2026', NOW), '2026-08-12')
  assert.equal(extractDate('Aug 12, 2026', NOW), '2026-08-12')
  assert.equal(extractDate('Today', NOW), '2026-08-11')
  assert.equal(extractDate('Yesterday', NOW), '2026-08-10')
  assert.equal(extractDate('31/02/26', NOW), null) // no such day
  assert.equal(extractDate('12 Aug 2027', NOW), null) // future = misread year
})

check('direction', () => {
  assert.equal(extractDirection('Paid to Swiggy'), 'debit')
  assert.equal(extractDirection('₹500 received from Rahul'), 'credit')
  assert.equal(extractDirection('no clue'), 'debit')
})

check('payee from vertical layout', () => {
  assert.equal(extractPayee(['₹450', 'Paid to', 'Swiggy', 'Completed']), 'Swiggy')
  assert.equal(extractPayee(['Paid to Zomato Ltd', '₹300']), 'Zomato Ltd')
  assert.equal(extractPayee(['Sent ₹200', 'rahul.k@okhdfcbank']), 'rahul.k@okhdfcbank')
})

check('personal payments never reach the API', () => {
  assert.equal(isPersonal('rahul.k@okhdfcbank'), true)
  assert.equal(isPersonal('Rahul Kumar'), true)
  assert.equal(isPersonal('SWIGGY'), false)
  assert.equal(isPersonal('BHARATPE09283746'), false)
})

check('app detection', () => {
  assert.equal(detectApp('Google Pay · UPI transaction ID 123'), 'gpay')
  assert.equal(detectApp('PhonePe Txn ID T2408'), 'phonepe')
  assert.equal(detectApp('random text'), 'unknown')
})

check('full parse of a GPay-shaped screenshot', () => {
  const t = parse(
    ['₹1,24,500', 'Paid to', 'Swiggy', '11 Aug 2026, 9:14 pm',
     'Google Pay', 'UPI transaction ID 412398765432'].join('\n'),
    NOW,
  )
  assert.equal(t.amount, 124500)
  assert.equal(t.payee_raw, 'Swiggy')
  assert.equal(t.txn_date, '2026-08-11')
  assert.equal(t.txn_time, '21:14:00')
  assert.equal(t.txn_ref, '412398765432')
  assert.equal(t.direction, 'debit')
  assert.equal(t.app, 'gpay')
  assert.equal(t.confidence, 1)
  assert.equal(t.needs_review, false)
})

check('unreadable screenshot is flagged, not saved silently', () => {
  const t = parse('some unrelated photo of a cat', NOW)
  assert.ok(t.confidence < 0.4, `confidence was ${t.confidence}`)
  assert.equal(t.needs_review, true)
})

check('synthetic ref is stable for the same payment', () => {
  const a = { txn_date: '2026-08-11', amount: 450, payee_raw: 'Chai Point' }
  assert.equal(synthRef(a), synthRef({ ...a }))
  assert.notEqual(synthRef(a), synthRef({ ...a, amount: 451 }))
})

console.log(`\n${n} checks passed`)
