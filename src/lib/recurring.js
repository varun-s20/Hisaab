// Extension included on purpose: this module is exercised by
// `node scripts/test-parse.mjs`, and Node will not resolve './format'.
import { iso, today } from './format.js'

// Two questions off the same grouping, because they are the same question asked
// at different speeds.
//
//   findRecurring — subscriptions you forgot you had. A steady cadence at a
//     steady price, three sightings minimum.
//   findFrequent  — the things you buy so often that typing them is the app's
//     main cost. Same merchant, same amount, four times in sixty days.
//
// Arithmetic on rows already loaded. No table, no API, no new column.

const MIN_HITS = 3
/** How far a gap may drift from the ideal and still count as that cadence. */
const CADENCES = [
  { name: 'weekly', days: 7, slack: 2, perMonth: 52 / 12 },
  { name: 'fortnightly', days: 14, slack: 3, perMonth: 26 / 12 },
  { name: 'monthly', days: 30.4, slack: 6, perMonth: 1 },
  { name: 'quarterly', days: 91, slack: 12, perMonth: 1 / 3 },
  { name: 'yearly', days: 365, slack: 30, perMonth: 1 / 12 },
]

const D = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86400000)

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const addDays = (s, n) => {
  const d = D(s)
  d.setDate(d.getDate() + n)
  return iso(d)
}

/** The value seen most often. Ties go to the smaller, so the answer is stable
 *  whatever order the rows arrived in. */
function mode(values) {
  const tally = new Map()
  for (const v of values) {
    if (v == null || v === '') continue
    tally.set(v, (tally.get(v) ?? 0) + 1)
  }
  let best = null
  let bestCount = 0
  for (const [v, n] of tally) {
    if (n > bestCount || (n === bestCount && v < best)) {
      best = v
      bestCount = n
    }
  }
  return { value: best, count: bestCount }
}

/**
 * Spending, gathered by merchant.
 *
 * Only expenses. A salary lands monthly too and calling it a subscription is
 * wrong; a transfer into an envelope is even more regular and is not a purchase
 * at all.
 */
function groupMerchants(rows, { since = null } = {}) {
  const byMerchant = new Map()
  for (const r of rows) {
    if (r.type !== 'expense' || !r.amount) continue
    if (since && r.txn_date < since) continue
    const name = r.payee_clean || r.payee_raw
    if (!name) continue
    const g = byMerchant.get(name) ?? {
      name,
      payee_raw: r.payee_raw ?? name,
      category: r.category ?? 'Other',
      dates: [],
      amounts: [],
      categories: [],
      methods: [],
      accounts: [],
    }
    g.dates.push(r.txn_date)
    g.amounts.push(Number(r.amount))
    g.categories.push(r.category)
    g.methods.push(r.method)
    g.accounts.push(r.account)
    byMerchant.set(name, g)
  }
  return byMerchant
}

/**
 * @param rows transactions, any order.
 * @returns [{ name, category, cadence, amount, count, last, next, perMonth }]
 */
export function findRecurring(rows) {
  const out = []
  for (const g of groupMerchants(rows).values()) {
    if (g.dates.length < MIN_HITS) continue
    const dates = [...new Set(g.dates)].sort()
    if (dates.length < MIN_HITS) continue

    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d))
    const gap = median(gaps)
    const cadence = CADENCES.find((c) => Math.abs(gap - c.days) <= c.slack)
    if (!cadence) continue

    // Every gap has to agree, not just the middle one. Three coffees in one week
    // and one a month later has a plausible median and is not a subscription.
    if (!gaps.every((x) => Math.abs(x - cadence.days) <= cadence.slack * 1.6)) continue

    // A steady cadence at a wildly varying price is a habit, not a bill.
    const amount = median(g.amounts)
    if (amount <= 0) continue
    const steady = g.amounts.every((a) => Math.abs(a - amount) <= Math.max(amount * 0.2, 20))
    if (!steady) continue

    const last = dates.at(-1)
    out.push({
      name: g.name,
      payee_raw: g.payee_raw,
      category: g.category,
      method: mode(g.methods).value,
      account: mode(g.accounts).value,
      cadence: cadence.name,
      amount,
      count: dates.length,
      last,
      next: addDays(last, Math.round(cadence.days)),
      perMonth: amount * cadence.perMonth,
    })
  }

  return out.sort((a, b) => b.perMonth - a.perMonth)
}

/** What all of it costs in a month, which is the number nobody has. */
export const committedPerMonth = (found) => found.reduce((s, f) => s + f.perMonth, 0)

/** How many days back a tile suggestion is allowed to look. */
export const FREQUENT_WINDOW = 60
/** Sightings needed before something is offered as a one-tap tile. */
export const FREQUENT_HITS = 4
/** How much of the spend at a merchant has to be at one price for the tile to
 *  carry that price. Below this it becomes a "fill in the amount" tile. */
export const FREQUENT_AGREEMENT = 0.6

/**
 * The handful of things worth a one-tap tile.
 *
 * The bar is deliberately high, and it is on the PAIR rather than the merchant.
 * A merchant alone is not enough: one chai from a stall you passed once is a
 * merchant with a repeat, and a tile for it is clutter you then have to go and
 * remove. Four sightings inside sixty days, with most of them at the same
 * price, is a habit.
 *
 * A merchant that repeats at genuinely varying prices — the weekly grocery run —
 * comes back with `exact: false`, which the screen offers as a tile that opens
 * the form with everything filled in but the amount. That is still most of the
 * typing saved and none of the wrong numbers.
 *
 * @returns [{ payee, amount, exact, category, type, method, account, count, last }]
 */
export function findFrequent(rows, { now = today(), window = FREQUENT_WINDOW, minHits = FREQUENT_HITS } = {}) {
  const since = addDays(now, -window)
  const out = []

  for (const g of groupMerchants(rows, { since }).values()) {
    if (g.amounts.length < minHits) continue

    const { value: amount, count: agreed } = mode(g.amounts)
    if (!(amount > 0)) continue

    out.push({
      payee: g.name,
      payee_raw: g.payee_raw,
      amount,
      exact: agreed / g.amounts.length >= FREQUENT_AGREEMENT,
      category: mode(g.categories).value ?? 'Other',
      method: mode(g.methods).value ?? null,
      account: mode(g.accounts).value ?? null,
      count: g.amounts.length,
      last: [...g.dates].sort().at(-1),
    })
  }

  // Most-used first, and a merchant seen the same number of times more recently
  // wins — the tile list should follow this month's habits, not last month's.
  return out.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
}
