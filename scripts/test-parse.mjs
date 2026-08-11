// The one runnable check. `node scripts/test-parse.mjs`
// Covers the parser failures that would silently corrupt the ledger:
// Indian comma grouping, day-first dates, direction, personal detection.

import assert from 'node:assert/strict'
import {
  parse, toNumber, extractDate, extractDirection, extractPayee,
  isPersonal, detectApp, synthRef, parseScreenshot,
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

// ── History-list screenshots ─────────────────────────────────────────────────
// Verbatim OCR from a real Paytm Payment History screenshot. Do not tidy it —
// the mangling is the point.
const HISTORY = `1:55 CIEE ul €
<— Balance & History
Total Spent
August 2026 Refresh
IC Indian Clearing Corporation Ltd -%1,000
~~ - Automatic Payment
Paid Today, 07:18 AM From A
i Financial
& Kunafa Mahal -394
Paid Yesterday, 11:01 PM From A
@ Food
SB Sachin Bhawan +3340
Received Yesterday, 09:57 PM In A
3 Money Received
MA Mohammad Amaan -%1,680
Sent Yesterday, 09:55 PM From A
3 Money Transfer
a Ms Shyam Departmental Store -%20
Paid on 09 Aug, 10:11 PM From 4
©. Groceries
paytm | = LIF`

check('one history screenshot yields many transactions', () => {
  const rows = parseScreenshot(HISTORY, NOW)
  assert.equal(rows.length, 5)
})

check('the rupee sign OCRs as 3, % or ¥ and is not a digit', () => {
  const [ic, kunafa, sachin, amaan] = parseScreenshot(HISTORY, NOW)
  assert.equal(ic.amount, 1000) // -%1,000
  assert.equal(kunafa.amount, 94) // -394 is ₹94, not ₹394
  assert.equal(sachin.amount, 340) // +3340 is ₹340
  assert.equal(amaan.amount, 1680)
})

check('relative dates and times inside a list', () => {
  const [ic, kunafa] = parseScreenshot(HISTORY, NOW)
  assert.equal(ic.txn_date, '2026-08-11')
  assert.equal(ic.txn_time, '07:18:00')
  assert.equal(kunafa.txn_date, '2026-08-10')
  assert.equal(kunafa.txn_time, '23:01:00')
})

check('year comes from the screen header, not the current date', () => {
  const [, , , , store] = parseScreenshot(HISTORY, NOW)
  assert.equal(store.txn_date, '2026-08-09') // "on 09 Aug", no year in the row
})

check('avatar initials are stripped from merchant names', () => {
  const rows = parseScreenshot(HISTORY, NOW)
  assert.deepEqual(
    rows.map((r) => r.payee_raw),
    ['Indian Clearing Corporation Ltd', 'Kunafa Mahal', 'Sachin Bhawan',
     'Mohammad Amaan', 'Ms Shyam Departmental Store'],
  )
})

check("the app's own category tag survives its icon glyph", () => {
  const rows = parseScreenshot(HISTORY, NOW)
  assert.deepEqual(
    rows.map((r) => r.category_hint),
    ['Transfers', 'Food & Dining', 'Transfers', 'Transfers', 'Groceries'],
  )
})

check('direction from the verb and the sign', () => {
  const rows = parseScreenshot(HISTORY, NOW)
  assert.deepEqual(
    rows.map((r) => r.direction),
    ['debit', 'debit', 'credit', 'debit', 'debit'],
  )
})

check('a row whose amount the OCR lost is flagged, not dropped', () => {
  const rows = parseScreenshot(
    ['Total Spent', 'August 2026',
     'ov Indian Clearing Corporation Ltd -3',
     '~~ - Automatic Payment of', '100000 Setup',
     'Paid on 04 Aug, 03:05 PM From A', 'if Financial'].join('\n'),
    NOW,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount, null)
  assert.equal(rows[0].payee_raw, 'Indian Clearing Corporation Ltd')
  assert.equal(rows[0].needs_review, true)
})

check('two identical amounts on one day stay two rows', () => {
  const a = { txn_date: '2026-08-01', txn_time: '20:42:00', amount: 50, payee_raw: 'Swiggy Diners' }
  const b = { ...a, txn_time: '22:26:00' }
  assert.notEqual(synthRef(a), synthRef(b))
})

check('a single receipt still parses as one row', () => {
  const rows = parseScreenshot('₹450\nPaid to\nSwiggy\nGoogle Pay\n11 Aug 2026', NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount, 450)
})

// The statement importer ships its own checks; run them from the same command.
const { selfTest } = await import('../src/lib/statement.js')
check('statement CSV parser', () => {
  const failures = selfTest()
  assert.equal(failures, 0, `${failures} statement check(s) failed`)
})

console.log(`\n${n} checks passed`)
