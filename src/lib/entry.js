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
const CADENCE_RULE = {
  weekly: (d) => ({ every: 1, unit: 'week', weekday: d.getDay() }),
  fortnightly: (d) => ({ every: 2, unit: 'week', weekday: d.getDay() }),
  monthly: (d) => ({ every: 1, unit: 'month', monthDay: d.getDate() }),
  quarterly: (d) => ({ every: 3, unit: 'month', monthDay: d.getDate() }),
  yearly: (d) => ({ every: 1, unit: 'year', monthDay: d.getDate() }),
}

export function templateFromRecurring(f) {
  const [y, m, day] = f.next.split('-').map(Number)
  const anchor = new Date(y, m - 1, day)
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
    rule: CADENCE_RULE[f.cadence]?.(anchor) ?? null,
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
