// The one runnable check. `node scripts/test-parse.mjs`
// Covers the parser failures that would silently corrupt the ledger:
// Indian comma grouping, day-first dates, direction, personal detection.

import assert from 'node:assert/strict'
import {
  parse, toNumber, extractDate, extractDirection, extractPayee,
  isPersonal, detectApp, synthRef, parseScreenshot,
} from '../src/lib/parse.js'
import { seedLookup } from '../src/lib/seeds.js'

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

// Verbatim OCR of a real GPay history screen. Note "August" came out "aoe",
// the year sits on its own line, and debits carry no sign at all.
const GPAY = `2:16 RT |
& Search transactions $ :
Status ~ Payment method ~ Date ~
2026
aoe +398,381
gr) Yasharth Saxena +3580
W@W 9 August
(E Eazy Diner Private Limited 3837
7 August
(E Eazydiner Private Limited 21136
5 August
O Mehta chetan +350,000
a 3 August`

check('GPay history: unsigned rows are debits, signed rows are credits', () => {
  const rows = parseScreenshot(GPAY, NOW)
  assert.deepEqual(
    rows.map((r) => [r.payee_raw, r.direction, r.amount]),
    [
      ['Yasharth Saxena', 'credit', 580],
      ['Eazy Diner Private Limited', 'debit', 837],
      ['Eazydiner Private Limited', 'debit', 1136],
      ['Mehta chetan', 'credit', 50000],
    ],
  )
})

check('GPay: the year comes from a line of its own', () => {
  const rows = parseScreenshot(GPAY, NOW)
  assert.deepEqual(rows.map((r) => r.txn_date), [
    '2026-08-09', '2026-08-07', '2026-08-05', '2026-08-03',
  ])
})

check('a month total is not a transaction', () => {
  // "aoe +398,381" is August's header. It must not become a ₹98,381 payment.
  const rows = parseScreenshot(GPAY, NOW)
  assert.equal(rows.some((r) => r.amount === 98381), false)
})

const PHONEPE = `History © My Statements
July 2026
Received from
¥ Dad +%25,000
31 Jul Credited to Paytm
May 2026
Received from
¥ Dad + 71,650
12 May Credited to Paytm`

check('PhonePe history: month sections carry the year', () => {
  const rows = parseScreenshot(PHONEPE, NOW)
  assert.deepEqual(
    rows.map((r) => [r.payee_raw, r.direction, r.amount, r.txn_date, r.account]),
    [
      ['Dad', 'credit', 25000, '2026-07-31', 'Paytm'],
      ['Dad', 'credit', 1650, '2026-05-12', 'Paytm'],
    ],
  )
})

check('the rupee glyph is one character, whatever it OCRs as', () => {
  // Same amount, three renderings of ₹ seen across the three apps.
  const of = (line, date) =>
    parseScreenshot(`Payment History\nAugust 2026\n${line}\nPaid on 09 Aug, 10:11 PM`, date)[0].amount
  assert.equal(of('X Shop -%1,650', NOW), 1650) // read as %
  assert.equal(of('X Shop -31,650', NOW), 1650) // read as 3
  assert.equal(of('X Shop -71,650', NOW), 1650) // read as 7
  assert.equal(of('X Shop -₹1,650', NOW), 1650) // read correctly
})

check('a brand that reads like a person is still a brand', () => {
  // "Swiggy Diners" matches Firstname-Lastname. If the personal check ran
  // first, a ₹1,978 dinner would be typed as a transfer and vanish from spend.
  assert.equal(isPersonal('Swiggy Diners'), true)
  assert.equal(seedLookup('Swiggy Diners'), 'Food & Dining')
  assert.equal(seedLookup('Mohammad Amaan'), null)
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
