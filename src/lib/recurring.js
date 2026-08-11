// Extension included on purpose: this module is exercised by
// `node scripts/test-parse.mjs`, and Node will not resolve './format'.
import { iso } from './format.js'

// Subscriptions you forgot you had. Arithmetic on rows already loaded — no
// table, no API, no new column. A payment is recurring when the same merchant
// shows up on a steady cadence for a steady amount; two of anything is a
// coincidence, so the floor is three.

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

/**
 * @param rows transactions, any order. Only expenses are considered — a salary
 *             lands monthly too, and calling it a subscription is wrong.
 * @returns [{ name, category, cadence, amount, count, last, next, perMonth }]
 */
export function findRecurring(rows) {
  const byMerchant = new Map()
  for (const r of rows) {
    if (r.type !== 'expense' || !r.amount) continue
    const name = r.payee_clean || r.payee_raw
    if (!name) continue
    const g = byMerchant.get(name) ?? { name, category: r.category ?? 'Other', dates: [], amounts: [] }
    g.dates.push(r.txn_date)
    g.amounts.push(Number(r.amount))
    byMerchant.set(name, g)
  }

  const out = []
  for (const g of byMerchant.values()) {
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
      category: g.category,
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
