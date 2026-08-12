// Indian grouping (1,00,000) everywhere a number is shown.
const grouper = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const grouper2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const money = (n) => grouper.format(Math.round(Number(n) || 0))
export const money2 = (n) => grouper2.format(Number(n) || 0)

/** ISO date string for a Date, in local time (never toISOString — that's UTC). */
export const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const today = () => iso(new Date())

export function startOfMonth(d = new Date()) {
  return iso(new Date(d.getFullYear(), d.getMonth(), 1))
}

export function daysInMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

const DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })

export function dayLabel(isoDate) {
  const t = today()
  if (isoDate === t) return 'Today'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  if (isoDate === iso(y)) return 'Yesterday'
  const [yy, mm, dd] = isoDate.split('-').map(Number)
  return DAY_FMT.format(new Date(yy, mm - 1, dd))
}

export function timeLabel(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const ap = h >= 12 ? 'pm' : 'am'
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`
}

/** Sum only real spending. Transfers, income, lending are money moving, not gone. */
export const spendTotal = (rows) =>
  rows.reduce((s, r) => (r.type === 'expense' ? s + Number(r.amount) : s), 0)

/** Money that genuinely arrived. A transfer in is your own money, not income,
 *  so it counts in neither total — which is why these two don't sum to zero. */
export const earnTotal = (rows) =>
  rows.reduce(
    (s, r) => (r.type === 'income' || r.type === 'refund' || r.type === 'repaid' ? s + Number(r.amount) : s),
    0,
  )

/** Money put away rather than spent. Its own total, because an SIP is neither
 *  a cost nor an earning and folding it into either makes both wrong. */
export const investTotal = (rows) =>
  rows.reduce((s, r) => (r.type === 'investment' ? s + Number(r.amount) : s), 0)
