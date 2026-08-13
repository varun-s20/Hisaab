import { today } from './format.js'

// What the add form opens on.
//
// Three things fill it: nothing (a blank entry), a row you are duplicating, and
// a repeat you are logging. They all produce the same object so the form has
// one input rather than three code paths, and so "duplicate" and "tap a tile"
// cannot drift apart in what they carry across.

/** Which way the money goes for a kind of payment. A new entry gets this by
 *  default so income is not logged as a debit by a form that opened on one —
 *  it stays editable, because a refund on a credit card is a real thing. */
export const NATURAL_DIRECTION = {
  expense: 'debit',
  investment: 'debit',
  transfer: 'debit',
  lent: 'debit',
  income: 'credit',
  refund: 'credit',
  repaid: 'credit',
}

export const blankEntry = () => ({
  amount: '',
  payee: '',
  category: '',
  txn_date: today(),
  txn_time: '',
  type: 'expense',
  direction: 'debit',
  method: '',
  account: '',
  to_account: '',
  note: '',
})

/**
 * A transaction, ready to be logged again.
 *
 * Dated today rather than on the original's date — the point of duplicating
 * yesterday's auto fare is that you took one again today. The time is dropped
 * for the same reason: it belonged to the original payment.
 *
 * `payee_clean` before `payee_raw`, matching what every row on screen shows.
 * The raw text is the OCR's, and re-logging "PAYTM*BLINKIT COMMERCE" is not
 * what anyone means by "again".
 */
export const seedFromRow = (r) => ({
  ...blankEntry(),
  amount: r.amount == null ? '' : String(r.amount),
  payee: r.payee_clean || r.payee_raw || '',
  category: r.category ?? '',
  type: r.type ?? 'expense',
  direction: r.direction ?? 'debit',
  method: r.method ?? '',
  account: r.account ?? '',
  to_account: r.to_account ?? '',
  note: r.note ?? '',
})

/**
 * One patch for many rows, from a form where every field starts on "leave
 * unchanged". Only what was set is sent.
 *
 * The two couplings are the same ones EditSheet and ManualEntry enforce on a
 * single row, and they matter more here because a bulk edit is where nobody
 * checks the result:
 *
 *   direction follows type — retyping ten rows as refunds and leaving them
 *   `debit` drops them out of every total AND keeps accountBalances taking the
 *   money out of the account, with a minus still on screen. Wrong in three
 *   places, flagged in none. Setting direction yourself still wins: a refund
 *   onto a credit card really is money out of the card.
 *
 *   a row that stops being a transfer loses its destination — otherwise the
 *   stale `to_account` sits there inert until someone types the row back to a
 *   transfer, and an envelope is credited by a payment that no longer goes
 *   there.
 */
export function bulkPatch(d) {
  const patch = {}
  for (const k of ['category', 'type', 'direction', 'method', 'account']) {
    if (d[k]) patch[k] = d[k]
  }
  if (patch.type && !patch.direction && NATURAL_DIRECTION[patch.type]) {
    patch.direction = NATURAL_DIRECTION[patch.type]
  }
  if (patch.type && patch.type !== 'transfer') patch.to_account = null
  // A category chosen by hand is not something the parser is unsure about.
  // Nothing else clears the flag: naming the account says nothing about
  // whether the category was right.
  if (patch.category) patch.needs_review = false
  return patch
}

/** A saved repeat — a tile or a bill — as the form's starting point. */
export const seedFromTemplate = (t, { on = today() } = {}) => ({
  ...blankEntry(),
  amount: t.amount == null ? '' : String(t.amount),
  payee: t.payee ?? '',
  category: t.category ?? '',
  txn_date: on,
  type: t.type ?? 'expense',
  direction: t.direction ?? 'debit',
  method: t.method ?? '',
  account: t.account ?? '',
  to_account: t.to_account ?? '',
  note: t.note ?? '',
})

/**
 * A subscription the app spotted, as a bill waiting to be tracked.
 *
 * The cadences findRecurring reports are the five it can recognise from gaps
 * between payments; these are the rules that mean the same thing. The date it
 * expects next becomes the anchor, so the first occurrence this schedules is
 * the one the detector was already predicting — and `last_posted_on` stays
 * null, because nothing has been confirmed through the bill yet. The payments
 * that revealed the pattern are already in the ledger and are not re-posted.
 */
/**
 * Which date each cadence takes its anchor from, and they are not the same one.
 *
 * findRecurring predicts `next` by adding the cadence's average length in DAYS
 * to the last sighting, because days are all a gap between two payments can tell
 * you. That is exact for a weekday — seven or fourteen days later is the same
 * day of the week — and wrong for a day of the month, because months are not
 * 30.4 days long. Netflix charged on 5 August is predicted for 4 September, and
 * a rule built off that date says "the 4th, every month" — a bill a day early,
 * every month, for as long as it is tracked. Quarterly drifts the same way and
 * yearly does it in leap years.
 *
 * So the calendar cadences take their day of the month from `last`, which is a
 * date the payment genuinely happened on, and the weekly ones keep taking their
 * weekday from `next`, where the arithmetic is exact.
 */
const CADENCE_RULE = {
  weekly: (next) => ({ every: 1, unit: 'week', weekday: next.getDay() }),
  fortnightly: (next) => ({ every: 2, unit: 'week', weekday: next.getDay() }),
  monthly: (next, last) => ({ every: 1, unit: 'month', monthDay: last.getDate() }),
  quarterly: (next, last) => ({ every: 3, unit: 'month', monthDay: last.getDate() }),
  yearly: (next, last) => ({ every: 1, unit: 'year', monthDay: last.getDate() }),
}

const asDate = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function templateFromRecurring(f) {
  const next = asDate(f.next)
  // `next` again when there is no last sighting to read, which findRecurring
  // never produces — it needs three of them — but a hand-built object might.
  const last = f.last ? asDate(f.last) : next
  return {
    label: f.name.slice(0, 40),
    payee: f.name,
    amount: f.amount,
    category: f.category ?? null,
    type: 'expense',
    direction: 'debit',
    method: f.method ?? null,
    account: f.account ?? null,
    note: null,
    rule: CADENCE_RULE[f.cadence]?.(next, last) ?? null,
    // Still the predicted date, so the first occurrence this schedules is the
    // one the detector was already showing. The rule above is what puts it on
    // the right day; this only says when to start looking.
    starts_on: f.next,
    last_posted_on: null,
    pinned: false,
    source: 'detected',
  }
}

/** A dismissal. Carries the name and nothing else — it exists so the detector
 *  stops offering something the user has already said no to. */
export const dismissal = (payee) => ({
  label: String(payee).slice(0, 40),
  payee,
  amount: null,
  rule: null,
  pinned: false,
  hidden: true,
  source: 'detected',
})

/** A suggestion off the ledger (lib/recurring.js findFrequent), as a template
 *  row waiting to be pinned. Not stored until the user says so. */
export const templateFromSuggestion = (s) => ({
  label: s.payee.slice(0, 40),
  payee: s.payee,
  amount: s.exact ? s.amount : null,
  category: s.category ?? null,
  type: 'expense',
  direction: 'debit',
  method: s.method ?? null,
  account: s.account ?? null,
  note: null,
  rule: null,
  pinned: true,
  source: 'detected',
})

// ── What the fold opens on next time ───────────────────────────────────────
//
// Only the two fields that are the same on nearly every payment a given person
// makes: which rail, and which pocket. Not the amount, not the payee, not the
// category — a form that guesses those is a form that logs the wrong thing when
// somebody taps Save without reading.
//
// localStorage rather than a table: it is a convenience about this device, and
// it is dropped on a change of user by App.jsx along with the merchant map and
// the account list. It would otherwise show the last person's bank on a shared
// phone.

const KEY = 'hisaab.entry.defaults'

export function readEntryDefaults() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { method: raw.method ?? '', account: raw.account ?? '' }
  } catch {
    return { method: '', account: '' }
  }
}

export function writeEntryDefaults({ method, account }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ method: method ?? '', account: account ?? '' }))
  } catch {
    // Storage blocked. The entry still saved; only the next form's defaults are lost.
  }
}

export function forgetEntryDefaults() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing was persisted to leak in the first place.
  }
}
