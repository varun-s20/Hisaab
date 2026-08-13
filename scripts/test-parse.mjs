// The one runnable check. `node scripts/test-parse.mjs`
// Covers the parser failures that would silently corrupt the ledger:
// Indian comma grouping, day-first dates, direction, personal detection.

import assert from 'node:assert/strict'
import {
  parse, toNumber, extractDate, extractDirection, extractPayee,
  isPersonal, detectApp, synthRef, parseScreenshot,
} from '../src/lib/parse.js'
import { seedLookup } from '../src/lib/seeds.js'
import { suggestCategory } from '../src/lib/categorise.js'
import { sanitise, guess, uncategorisedNote, applySpec, group } from '../src/lib/query.js'

const NOW = new Date(2026, 7, 11) // 11 Aug 2026
let n = 0
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`) }
// Same thing for a check that has to await. Kept separate so the sync ones
// stay callable without `await`, which is every one of them above.
const acheck = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`) }

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

check('a registered business is not a person', () => {
  // Three Title-case words. Read as a person, its spend disappears into
  // transfers — which is exactly what happened to ₹1,136 of dinner.
  assert.equal(isPersonal('Eazydiner Private Limited'), false)
  assert.equal(isPersonal('Destiny Retail Mdpl'), false)
  assert.equal(isPersonal('Wellness Chemist'), false)
  assert.equal(isPersonal('Shyam Departmental Store'), false)
  assert.equal(isPersonal('Yasharth Saxena'), true) // still a person
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

check('a premium and an instalment are spending, not money moving', () => {
  // Both used to seed to 'Transfers', which types the row `transfer`, which is
  // in no total on any screen. So an LIC premium and a car EMI left the account
  // every month and appeared in nobody's spending — the two largest fixed costs
  // most people have, invisible.
  assert.equal(seedLookup('LIC OF INDIA'), 'Bills & Utilities')
  assert.equal(seedLookup('HDFC Ergo Insurance'), 'Bills & Utilities')
  assert.equal(seedLookup('Loan EMI'), 'Bills & Utilities')
  // …and LIC is anchored, so it does not swallow the words it is a substring of.
  assert.equal(seedLookup('Public Works Dept'), null)
  assert.equal(seedLookup('Policy Renewal Co'), null)

  // The brokers stay where they were, and on purpose: an SIP is your own money
  // changing pockets, and nothing in a payee string tells a ₹5,000 purchase
  // from a ₹5,000 redemption. `investment` is set by hand.
  assert.equal(seedLookup('Groww'), 'Transfers')
  assert.equal(seedLookup('SIP Mutual Fund'), 'Transfers')
  assert.equal(seedLookup('CRED'), 'Transfers')
})

check('typing a merchant the app already knows fills the category in', () => {
  // The add form used to save every typed row as 'Other' and put it in the
  // Teach queue, where the app then offered the answer out of the very rules
  // below — work it invented for itself while somebody was already typing.
  assert.equal(suggestCategory('Swiggy'), 'Food & Dining')
  assert.equal(suggestCategory('Chai Point'), 'Food & Dining')
  assert.equal(suggestCategory('Uber'), 'Transport')
  // A friend's name is a transfer, decided on this device and never sent.
  assert.equal(suggestCategory('Mohammad Amaan'), 'Transfers')
  // Nothing recognised is nothing suggested — the picker stays on "Pick one"
  // rather than filing a stranger under a guess.
  assert.equal(suggestCategory('Zzqq Traders 4471'), null)
  assert.equal(suggestCategory(''), null)
  assert.equal(suggestCategory(undefined), null)
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

// ── Recurring detection ────────────────────────────────────────────────────
// A false positive here tells you a habit is a subscription and inflates the
// "committed every month" figure, so both directions are worth pinning.
const { findRecurring, committedPerMonth } = await import('../src/lib/recurring.js')

const txn = (payee, date, amount, type = 'expense') => ({
  payee_clean: payee, txn_date: date, amount, type, category: 'Entertainment',
})

check('a steady monthly charge is recurring', () => {
  const found = findRecurring([
    txn('Netflix', '2026-05-14', 649),
    txn('Netflix', '2026-06-14', 649),
    txn('Netflix', '2026-07-14', 649),
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].cadence, 'monthly')
  assert.equal(found[0].amount, 649)
  assert.equal(found[0].next, '2026-08-13') // 30 days after the last sighting
  assert.equal(Math.round(committedPerMonth(found)), 649)
})

check('a wildly varying amount is a habit, not a bill', () => {
  assert.equal(
    findRecurring([
      txn('Swiggy', '2026-05-14', 1978),
      txn('Swiggy', '2026-06-14', 15),
      txn('Swiggy', '2026-07-14', 845),
    ]).length,
    0,
  )
})

check('a plausible median with erratic gaps is rejected', () => {
  // Three in one week then one a month later medians to ~monthly and is not.
  assert.equal(
    findRecurring([
      txn('Cafe', '2026-07-01', 200),
      txn('Cafe', '2026-07-02', 200),
      txn('Cafe', '2026-08-31', 200),
    ]).length,
    0,
  )
})

check('two sightings are a coincidence', () => {
  assert.equal(findRecurring([txn('Gym', '2026-06-01', 1500), txn('Gym', '2026-07-01', 1500)]).length, 0)
})

check('salary is not a subscription', () => {
  const salary = ['2026-05-01', '2026-06-01', '2026-07-01'].map((d) => txn('Acme Payroll', d, 90000, 'income'))
  assert.equal(findRecurring(salary).length, 0)
})

// ── Ask: the model's spec is untrusted, and the offline reader has to be
// ── repeatable. Both were wrong in ways nothing on screen looked wrong for.

check('a spec field the model got wrong is dropped, not passed through', () => {
  const s = sanitise({
    from: '2026-13-45', // shape is right, the date does not exist
    to: '2026-08-01',
    categories: ['Food & Dining', 'Nonsense'],
    types: ['expense', 'drop-table'],
    methods: ['gpay', 'unknown-rail'],
    groupBy: 'merchant; drop',
    sort: 'whatever',
    minAmount: '500', // JSON mode returns numbers as strings often enough
    maxAmount: -3,
    answer: 'x'.repeat(500),
  }, { methods: ['gpay'] })

  assert.equal(s.from, null)
  assert.equal(s.to, '2026-08-01')
  assert.deepEqual(s.categories, ['Food & Dining'])
  assert.deepEqual(s.types, ['expense'])
  assert.deepEqual(s.methods, ['gpay'])
  assert.equal(s.groupBy, null)
  assert.equal(s.sort, 'date')
  assert.equal(s.minAmount, 500)
  assert.equal(s.maxAmount, null)
  assert.equal(s.answer.length, 160)
})

check('one offline question does not leak into the next', () => {
  const a = guess('how much on food last month')
  const b = guess('how much on transport this month')
  assert.deepEqual(a.categories, ['Food & Dining'])
  assert.deepEqual(b.categories, ['Transport'])
})

check('a question word is not a merchant name', () => {
  // Whatever survived the vocabulary used to become spec.merchant verbatim, so
  // this filtered on a payee containing "major transaction", matched nothing,
  // and Ask answered every such question with a confident ₹0.
  const a = guess('what was my major transaction')
  assert.equal(a.merchant, null)
  assert.equal(a.sort, 'amount')
  assert.deepEqual(a.types, []) // "transaction" means any kind, not just spend
  const b = guess('biggest payment this month')
  assert.equal(b.merchant, null)
  assert.equal(b.sort, 'amount')
  // A real merchant still survives.
  assert.equal(guess('what did i spend at swiggy').merchant, 'swiggy')
})

check('an investment question asks for investments', () => {
  assert.deepEqual(guess('how much did i invest last month').types, ['investment'])
  assert.deepEqual(guess('total sip this year').types, ['investment'])
  assert.deepEqual(guess('money received last 30 days').types, ['income', 'refund', 'repaid'])
  assert.deepEqual(guess('how much on food').types, ['expense'])
})

check('a category name is text, not a pattern', () => {
  // A user-invented "Rent(" used to throw SyntaxError out of new RegExp and
  // wedge the Ask screen on its spinner with no way back.
  assert.doesNotThrow(() => guess('what did i spend', { methods: ['gpay('] }))
})

check('a relative date belongs to the screenshot, not to the upload', () => {
  // Every payment app writes "Today" / "Yesterday", so the row is only as right
  // as the clock it is resolved against. Today.jsx passes the file's
  // lastModified, so a Tuesday screenshot dropped in on Wednesday is still
  // Tuesday's payment.
  const shot = `Payment history
& Kunafa Mahal -394
Paid Today, 07:18 PM From Axis
@ Food`
  const tue = new Date(2026, 7, 11) // Tue 11 Aug
  const wed = new Date(2026, 7, 12)
  assert.equal(parseScreenshot(shot, tue)[0].txn_date, '2026-08-11')
  assert.equal(parseScreenshot(shot, wed)[0].txn_date, '2026-08-12')
  assert.equal(parseScreenshot(shot, tue)[0].txn_time, '19:18:00')
})

// ── Reminders: only when there is something to say ─────────────────────────

const { due, DEFAULTS } = await import('../src/lib/notify.js')

check('a reminder fires once per period, and only when it is useful', () => {
  const on = { ...DEFAULTS, enabled: true, dailyHour: 21 }
  const first = new Date(2026, 8, 1, 9, 0) // 1 Sep, morning
  const evening = new Date(2026, 8, 2, 21, 30)

  // The 1st, with no whole-month budget set.
  assert.deepEqual(due(on, { hasBudget: false }, first).map((r) => r.id), ['budget'])
  // Already has one — nothing to ask for.
  assert.deepEqual(due(on, { hasBudget: true }, first), [])
  // Fired already this month.
  assert.deepEqual(due({ ...on, shown: { budget: '2026-09' } }, { hasBudget: false }, first), [])

  // The evening nudge, only on a day with nothing logged.
  assert.deepEqual(due(on, { loggedToday: false }, evening).map((r) => r.id), ['daily'])
  assert.deepEqual(due(on, { loggedToday: true }, evening), [])
  // Too early.
  assert.deepEqual(due(on, { loggedToday: false }, new Date(2026, 8, 2, 15, 0)), [])

  // Sunday, and only if a queue is actually waiting.
  const sunday = new Date(2026, 8, 6, 21, 30)
  assert.ok(due(on, { loggedToday: true, reviewCount: 3 }, sunday).some((r) => r.id === 'weekly'))
  assert.ok(!due(on, { loggedToday: true, reviewCount: 0 }, sunday).some((r) => r.id === 'weekly'))

  // Off is off.
  assert.deepEqual(due({ ...DEFAULTS, daily: false, monthly: false, weekly: false }, {}, evening), [])
})

// ── A category answer over an unfiled ledger ───────────────────────────────

check('a category question names the payments it could not see', () => {
  const rows = [
    { txn_date: '2026-08-01', type: 'expense', category: 'Other', amount: 400, payee_raw: 'A' },
    { txn_date: '2026-08-02', type: 'expense', category: null, amount: 250, payee_raw: 'B' },
    { txn_date: '2026-08-03', type: 'expense', category: 'Food & Dining', amount: 300, payee_raw: 'C' },
    // Excluded by the spec's own type filter, so not part of this answer.
    { txn_date: '2026-08-04', type: 'transfer', category: 'Other', amount: 900, payee_raw: 'D' },
  ]
  const food = sanitise({ categories: ['Food & Dining'], types: ['expense'] })
  assert.match(uncategorisedNote(food, rows), /^2 payments here have no category/)

  // No category filter means nothing was hidden by one — say nothing.
  assert.equal(uncategorisedNote(sanitise({ types: ['expense'] }), rows), null)

  // Nothing unfiled, nothing to say.
  assert.equal(uncategorisedNote(food, [rows[2]]), null)

  // The period of the real question still applies: only the 3rd is in range,
  // and it is already categorised.
  const lastDay = sanitise({ categories: ['Food & Dining'], types: ['expense'], from: '2026-08-03', to: '2026-08-03' })
  assert.equal(uncategorisedNote(lastDay, rows), null)

  // Singular reads as English.
  assert.match(uncategorisedNote(food, [rows[0], rows[2]]), /^1 payment here has no category/)
})

// ── Statements: a sign is a direction ──────────────────────────────────────

const { parseStatement } = await import('../src/lib/statement.js')
// export.js pulls in db.js → supabase, which needs a browser env. toCSV itself
// is pure, so it is redeclared here rather than imported: the writer and the
// reader still have to agree, and that is what the round trip below checks.
const { toCSV } = await import('../src/lib/csv.js')

check('a + on a single-amount column is money in', () => {
  const { rows } = parseStatement(
    'Date,Description,Amount\n05-08-2026,"UPI RECEIVED FROM RAHUL","+5,000"\n06-08-2026,"SWIGGY","-450"',
  )
  assert.equal(rows[0].direction, 'credit')
  assert.equal(rows[0].amount, 5000)
  assert.equal(rows[1].direction, 'debit')
})

// ── Accounts are their own axis ────────────────────────────────────────────
// The card, bank or envelope the money left, as distinct from the rail it
// travelled on. Both are open lists now, so both are user-supplied text and
// both have to survive sanitise() without becoming a pattern.

const WALLETS = { methods: ['gpay', 'Amex'], accounts: ['HDFC card', 'Needs', 'SBI Bank'] }

check('an account this ledger has never seen is dropped', () => {
  const s = sanitise({ accounts: ['HDFC card', 'Barclays'], groupBy: 'account' }, WALLETS)
  assert.deepEqual(s.accounts, ['HDFC card'])
  assert.equal(s.groupBy, 'account')
})

check('an account name is text, not a pattern', () => {
  // Named after the same failure the category test pins: a name reaching a
  // RegExp unescaped turns "HDFC (card)" into a syntax error or, worse, a
  // matcher for something else entirely.
  const g = guess('what did i spend from HDFC card', WALLETS)
  assert.deepEqual(g.accounts, ['HDFC card'])
  // The account name is consumed, so it is not left behind to be read as a
  // merchant — the whole question would otherwise filter on payee "hdfc card".
  assert.equal(g.merchant, null)
})

check('the longest account name wins', () => {
  // 'SBI Bank' and a bare 'Bank' would both match; taking the short one leaves
  // "SBI" loose in the leftover and it becomes a merchant filter.
  const g = guess('how much came out of SBI Bank last month', WALLETS)
  assert.deepEqual(g.accounts, ['SBI Bank'])
})

check('which card is an account question, which app is a method one', () => {
  assert.equal(guess('which card did i use most', WALLETS).groupBy, 'account')
  assert.equal(guess('which envelope did it come out of', WALLETS).groupBy, 'account')
  assert.equal(guess('which app did i pay with', WALLETS).groupBy, 'method')
})

check('rows are filtered and grouped by account', () => {
  const rows = [
    { txn_date: '2026-08-01', type: 'expense', amount: 100, account: 'Needs', category: 'Health' },
    { txn_date: '2026-08-02', type: 'expense', amount: 250, account: 'Needs', category: 'Health' },
    { txn_date: '2026-08-03', type: 'expense', amount: 900, account: 'HDFC card', category: 'Shopping' },
    { txn_date: '2026-08-04', type: 'expense', amount: 40, account: null, category: 'Food & Dining' },
  ]
  const only = applySpec(rows, sanitise({ accounts: ['Needs'] }, WALLETS))
  assert.equal(only.length, 2)
  assert.equal(only.reduce((s, r) => s + r.amount, 0), 350)

  const groups = group(rows, 'account')
  assert.deepEqual(
    groups.map((g) => [g.key, g.total]),
    [['HDFC card', 900], ['Needs', 350], ['Not recorded', 40]],
  )
})

// ── Another tracker's export ───────────────────────────────────────────────
// Shaped exactly like ref/my_money_data_jul_aug.csv, down to the trailing space
// after the last header and the newline inside a quoted note. Every field here
// is one that used to be read wrongly or not at all.
//
// The shape is real; the money is invented. ref/ is gitignored because it is
// somebody's actual ledger, and a fixture copied straight out of it would have
// committed their salary to the repository to make the same assertions pass.

const MYMONEY =
  '"TIME","TYPE","AMOUNT","CATEGORY","ACCOUNT","NOTES" \n' +
  '"Jul 09, 2026 10:59 AM","(-) Expense","1250.00","Education","Savings","course subscription " \n' +
  '"Jul 09, 2026 12:41 PM","(+) Income","40000.00","Salary","Bank","salary jun 26" \n' +
  '"Jul 10, 2026 1:32 PM","(-) Expense","30.00","Food","Savings","soy milk " \n' +
  '"Jul 11, 2026 4:44 AM","(*) Transfer","15000.00","  -  ","Bank->Savings","savings for jul26" \n' +
  '"Jul 11, 2026 4:44 AM","(-) Expense","500.00","Adjustment-","Needs","" \n' +
  '"Jul 10, 2026 8:08 PM","(-) Expense","6000.00","Health","Recurring Payments","gym membership.\n\npaid across two months" \n'

const my = parseStatement(MYMONEY, { now: new Date(2026, 7, 12) }).rows

check('a column called TIME is still the date column', () => {
  assert.equal(my.length, 6)
  assert.equal(my[0].txn_date, '2026-07-09')
  assert.equal(my[0].txn_time, '10:59:00')
  // 1:32 PM is 13:32, not 01:32. A whole afternoon filed as morning would
  // still land on the right day, so nothing would ever have flagged it.
  assert.equal(my[2].txn_time, '13:32:00')
})

check('income is money in, not money out', () => {
  // The whole bug in one row: "(+) Income" matched neither direction regex and
  // fell to the 'debit' default, so a salary was booked as spending.
  assert.equal(my[1].direction, 'credit')
  assert.equal(my[1].amount, 40000)
  // 'Salary' is not one of the fourteen. Left as-is, typeFor() sees a credit
  // in a category that is not Income and calls it a transfer — which counts in
  // no total at all, so the salary would vanish instead of merely landing in
  // the wrong one.
  assert.equal(my[1].category_hint, 'Income')
})

check('moving your own money between envelopes is not spending', () => {
  const t = my[3]
  assert.equal(t.category_hint, 'Transfers') // → typeFor() gives type 'transfer'
  assert.equal(t.amount, 15000)
  // Both sides, split. Left whole, "Bank->Savings" is its own account: it shows
  // in the picker, in "group by account", and in a balance for an envelope
  // nobody has — while the real Savings envelope never sees the money arrive.
  assert.equal(t.account, 'Bank')
  assert.equal(t.to_account, 'Savings')
  // With no note, the row reads as where it went rather than where it came
  // from — "Savings", not "Bank".
  assert.equal(t.payee_raw, 'savings for jul26')
})

check('an ordinary row has no destination', () => {
  assert.equal(my[0].account, 'Savings')
  assert.equal(my[0].to_account, null)
  // A hyphen in a name is not a separator. Only the arrow is.
  assert.equal(toCSV([{ txn_date: '2026-07-11', account: 'Adjustment-' }]).includes('"Adjustment-"'), true)
})

// ── The exit door ──────────────────────────────────────────────────────────

check('an export re-imports as the same rows', () => {
  const out = toCSV([
    { txn_date: '2026-08-01', txn_time: '13:32:00', payee_clean: 'Chai, hot', amount: 30, type: 'expense', category: 'Food & Dining', account: 'Wants', method: 'cash', txn_ref: 'r1', note: 'he said "hi"' },
    { txn_date: '2026-08-02', payee_raw: 'salary', amount: 40000, type: 'income', category: 'Income', account: 'Bank' },
  ])
  const { rows, skipped } = parseStatement(out, { now: new Date(2026, 7, 12) })
  assert.equal(skipped.length, 0)
  assert.equal(rows.length, 2)
  // A comma inside a merchant name and an escaped quote both survive the round
  // trip — the two things a hand-rolled CSV writer gets wrong.
  assert.equal(rows[0].payee_raw, 'Chai, hot')
  assert.equal(rows[0].amount, 30)
  assert.equal(rows[0].category_hint, 'Food & Dining')
  assert.equal(rows[0].account, 'Wants')
  assert.equal(rows[0].txn_ref, 'r1')
  // The Type column says income, so it comes back as money in rather than as
  // ₹40,000 of spending — the same rule the MyMoney import relies on.
  assert.equal(rows[1].direction, 'credit')
  assert.equal(rows[1].category_hint, 'Income')
})

check('an exported merchant name cannot run as a spreadsheet formula', () => {
  // The display name on a UPI screenshot is chosen by whoever you paid, is
  // OCR'd into payee_raw, and ends up in your export. Excel and Sheets evaluate
  // a cell starting = + @ even inside quotes, so the leading apostrophe is the
  // only thing standing between a merchant and code running on your machine.
  const out = toCSV([
    { txn_date: '2026-08-01', payee_raw: '=HYPERLINK("http://evil","Click")', amount: 10, note: '@SUM(A1)' },
  ])
  assert.equal(out.includes('"\'=HYPERLINK'), true, 'a formula must be prefixed')
  assert.equal(out.includes('"\'@SUM(A1)"'), true, 'so must a note')
  // A real negative number is a value, not an attack, and stays untouched.
  assert.equal(toCSV([{ txn_date: '2026-08-01', note: '-42' }]).includes('"-42"'), true)

  // …and the guard comes back off on re-import, so the round trip still holds.
  const { rows } = parseStatement(out, { now: new Date(2026, 7, 12) })
  assert.equal(rows[0].payee_raw, '=HYPERLINK("http://evil","Click")')
})

check("another app's category vocabulary maps onto ours", () => {
  assert.equal(my[0].category_hint, 'Education') // already one of the fourteen
  assert.equal(my[2].category_hint, 'Food & Dining') // 'Food' is not
  // Not a synonym of anything. Kept rather than flattened into Other — the row
  // carries the text either way, and Other is a lie about what they filed it as.
  assert.equal(my[4].category_hint, 'Adjustment-')
})

check('a row with an empty note is kept, not dropped', () => {
  // db.saveTransactions drops anything with no payee_raw at all, so this row —
  // a real date, a real amount, a real category — used to be thrown away for
  // want of a name.
  assert.equal(my[4].payee_raw, 'Adjustment-')
  assert.equal(my[4].amount, 500)
  assert.equal(my[4].needs_review, false)
})

check('a newline inside a quoted note does not split the row', () => {
  assert.equal(my[5].amount, 6000)
  assert.match(my[5].payee_raw, /^gym membership\. paid across two months$/)
})

check('a hand-made spreadsheet works too', () => {
  const { rows } = parseStatement(
    'Date,Item,Cost,Category\n03-08-2026,Auto to office,60,Transportation\n',
    { now: new Date(2026, 7, 12) },
  )
  assert.equal(rows[0].payee_raw, 'Auto to office')
  assert.equal(rows[0].amount, 60)
  assert.equal(rows[0].category_hint, 'Transport')
})

check('a bank statement is not re-read as a budgeting app', () => {
  // Dr/Cr in a type column must NOT become 'Income': an unrecognised bank
  // credit is usually a friend paying you back, and that call belongs to
  // typeFor(), which is deliberately more cautious about it.
  const { rows } = parseStatement(
    'Txn Date,Narration,Amount,Type\n01/08/2026,NEFT FROM RAHUL,"5,000",Cr\n',
    { now: new Date(2026, 7, 12) },
  )
  assert.equal(rows[0].direction, 'credit')
  assert.equal(rows[0].category_hint, null)
})

// ── The endpoints are ours alone ───────────────────────────────────────────
// Driven through the real default export rather than the helper, because the
// thing worth pinning is the *order*: the origin check has to happen before the
// body is parsed, or a cross-origin preflight — which carries no body — gets a
// 400 back and never reaches the block at all.

const { default: worker } = await import('../worker/index.js')

const call = (origin, init = {}) =>
  worker.fetch(
    new Request('https://hisaab.example.com/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ question: 'what did I spend' }),
      ...init,
    }),
    {},
  )

await acheck('another site cannot spend the Gemini key', async () => {
  assert.equal((await call('https://evil.example')).status, 403)
  // A sandboxed iframe or a file:// page sends this. Not us either.
  assert.equal((await call('null')).status, 403)
  // Preflight, no body: still blocked, and blocked for the right reason.
  assert.equal((await call('https://evil.example', { method: 'OPTIONS', body: undefined })).status, 403)
})

await acheck('our own origin reaches the auth check', async () => {
  // 401, not 403 — it got past the origin gate and was turned away for having
  // no token, which is requireUser doing its job.
  assert.equal((await call('https://hisaab.example.com')).status, 401)
  // No Origin header at all is curl, and CORS was never able to stop curl.
  // It reaches the same 401. That is the honest boundary.
  assert.equal((await call(null)).status, 401)
})

console.log(`\n${n} checks passed`)
