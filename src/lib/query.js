// Extensions included on purpose: this module is exercised by
// `node scripts/test-parse.mjs`, and Node will not resolve './format'.
import { iso, today } from './format.js'
import { TYPES, allCategories } from './categories.js'

// A question becomes a filter spec; the filter runs here, on rows that never
// left the device. Two things live in this file:
//
//   sanitise()  — the model's output is untrusted text. Every field is snapped
//                 to a value the app already knows about before it can touch
//                 anything. Nothing here is interpolated into a query string.
//   guess()     — a local fallback for the common shapes, so Ask still works
//                 with no key, no quota and no signal. The rest of the app
//                 fails soft; this does too.

const ISO = /^\d{4}-\d{2}-\d{2}$/
const GROUPS = ['category', 'merchant', 'method', 'day']

// A factory, not a shared constant. `{ ...EMPTY }` is a shallow copy, so
// guess() was pushing categories and methods into arrays that belonged to the
// module — every later question started pre-loaded with the last one's filters,
// and the spec object React was still holding for the previous answer changed
// underneath it.
const empty = () => ({
  from: null,
  to: null,
  categories: [],
  types: [],
  methods: [],
  merchant: null,
  minAmount: null,
  maxAmount: null,
  groupBy: null,
  sort: 'date',
  answer: '',
})

// `responseMimeType: 'application/json'` with no schema returns "500" as often
// as 500, and a rejected minAmount silently drops the constraint: "over ₹500"
// then matches everything, and describe() doesn't mention the filter, so
// nothing on screen looks wrong.
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

// The shape test alone accepts 2026-13-45, which reaches .gte('txn_date', …)
// and comes back as a raw Postgres error rendered in the Ask screen.
const date = (v) => {
  if (typeof v !== 'string' || !ISO.test(v)) return null
  const [y, m, d] = v.split('-').map(Number)
  const real = new Date(y, m - 1, d)
  return real.getFullYear() === y && real.getMonth() === m - 1 && real.getDate() === d ? v : null
}

/** A category or method name is user-supplied text, not a pattern. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Snap a model-supplied spec onto values this app actually has. */
export function sanitise(raw, { methods = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null

  const cats = new Set(allCategories())
  const meths = new Set(methods)
  const pick = (v, allowed) =>
    Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && allowed.has(x)))] : []

  let from = date(raw.from)
  let to = date(raw.to)
  if (from && to && from > to) [from, to] = [to, from]

  return {
    ...empty(),
    from,
    to,
    categories: pick(raw.categories, cats),
    types: pick(raw.types, new Set(TYPES)),
    methods: pick(raw.methods, meths),
    merchant: typeof raw.merchant === 'string' && raw.merchant.trim() ? raw.merchant.trim().slice(0, 60) : null,
    minAmount: num(raw.minAmount),
    maxAmount: num(raw.maxAmount),
    groupBy: GROUPS.includes(raw.groupBy) ? raw.groupBy : null,
    sort: raw.sort === 'amount' ? 'amount' : 'date',
    answer: typeof raw.answer === 'string' ? raw.answer.slice(0, 160) : '',
  }
}

// ── Local fallback ─────────────────────────────────────────────────────────
const back = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return iso(d)
}

const monthRange = (offset) => {
  const n = new Date()
  const a = new Date(n.getFullYear(), n.getMonth() + offset, 1)
  const b = new Date(n.getFullYear(), n.getMonth() + offset + 1, 0)
  return [iso(a), iso(b)]
}

const weekRange = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7)
  const a = iso(d)
  d.setDate(d.getDate() + 6)
  return [a, iso(d)]
}

const PERIODS = [
  [/\btoday\b/, () => [today(), today()]],
  [/\byesterday\b/, () => [back(1), back(1)]],
  [/\blast week\b/, () => weekRange(-1)],
  [/\bthis week\b|\bpast week\b/, () => weekRange(0)],
  [/\blast month\b/, () => monthRange(-1)],
  [/\bthis month\b/, () => monthRange(0)],
  [/\blast (\d+) days?\b/, (m) => [back(Number(m[1])), today()]],
  [/\bthis year\b/, () => [`${new Date().getFullYear()}-01-01`, today()]],
]

const IN_WORDS = /\b(received|credited|income|refund|paid me|came in|money in)\b/
const GROUP_WORDS = [
  [/\bwhich app|what app|payment method|platform|gpay|phonepe|paytm|upi|cash\b/, 'method'],
  [/\bwho|merchant|where did i (spend|pay)|shop\b/, 'merchant'],
  [/\bcategor|what did i spend (it )?on|where did (my|the) money\b/, 'category'],
  [/\bwhich day|busiest day|per day\b/, 'day'],
]

/**
 * Enough grammar for the questions people actually ask, with none of the
 * ambition. Used when the model is unreachable — and as the reason Ask is not
 * a dead screen offline.
 */
export function guess(question, { methods = [] } = {}) {
  const q = ` ${question.toLowerCase()} `
  const spec = empty()
  let rest = q

  for (const [re, fn] of PERIODS) {
    const m = q.match(re)
    if (m) {
      const [from, to] = fn(m)
      spec.from = from
      spec.to = to
      rest = rest.replace(re, ' ')
      break
    }
  }

  for (const c of allCategories()) {
    // "Food & Dining" is rarely typed in full — match on its first word too.
    const head = c.split(/[\s&]+/)[0].toLowerCase()
    if (head.length >= 4 && q.includes(head.toLowerCase())) {
      spec.categories.push(c)
      rest = rest.replace(new RegExp(escapeRe(head), 'gi'), ' ')
    }
  }

  for (const m of methods) {
    if (q.includes(m.toLowerCase())) {
      spec.methods.push(m)
      rest = rest.replace(new RegExp(escapeRe(m), 'gi'), ' ')
    }
  }

  spec.types = IN_WORDS.test(q) ? ['income', 'refund', 'repaid'] : ['expense']
  spec.groupBy = GROUP_WORDS.find(([re]) => re.test(q))?.[1] ?? null
  spec.sort = /\bbiggest|largest|most|top|highest\b/.test(q) ? 'amount' : 'date'

  // Whatever survives the known vocabulary is probably a merchant name.
  const leftover = rest
    .replace(/\b(how much|did i|do i|i|my|me|the|a|an|on|in|at|for|from|to|of|spend|spent|pay|paid|show|find|all|was|were|what|which|where|when|total|and|by|with|most|any)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (leftover.length >= 3) spec.merchant = leftover

  spec.answer = 'Best guess — the assistant was unreachable, so this was read on your phone.'
  return spec
}

// ── Execution ──────────────────────────────────────────────────────────────

export function applySpec(rows, spec) {
  const needle = spec.merchant?.toLowerCase()
  return rows.filter((r) => {
    if (spec.from && r.txn_date < spec.from) return false
    if (spec.to && r.txn_date > spec.to) return false
    if (spec.types.length && !spec.types.includes(r.type)) return false
    if (spec.categories.length && !spec.categories.includes(r.category)) return false
    if (spec.methods.length && !spec.methods.includes(r.method)) return false
    if (spec.minAmount != null && Number(r.amount) < spec.minAmount) return false
    if (spec.maxAmount != null && Number(r.amount) > spec.maxAmount) return false
    if (needle) {
      const hay = `${r.payee_clean ?? ''} ${r.payee_raw ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

const KEY = {
  category: (r) => r.category ?? 'Other',
  merchant: (r) => r.payee_clean || r.payee_raw || 'Unknown',
  method: (r) => r.method ?? 'Not recorded',
  day: (r) => r.txn_date,
}

export function group(rows, by) {
  if (!by) return []
  const m = new Map()
  for (const r of rows) {
    const k = KEY[by](r)
    const g = m.get(k) ?? { key: k, total: 0, count: 0 }
    g.total += Number(r.amount) || 0
    g.count += 1
    m.set(k, g)
  }
  const out = [...m.values()]
  return by === 'day' ? out.sort((a, b) => (a.key < b.key ? 1 : -1)) : out.sort((a, b) => b.total - a.total)
}

/** What the question is worth reading back: the filter, in words. */
export function describe(spec, methods) {
  const bits = []
  if (spec.categories.length) bits.push(spec.categories.join(', '))
  if (spec.methods.length) bits.push(`via ${spec.methods.join(', ')}`)
  if (spec.merchant) bits.push(`matching “${spec.merchant}”`)
  if (spec.types.length === 1) bits.push(spec.types[0])
  if (spec.minAmount != null) bits.push(`over ₹${spec.minAmount}`)
  if (spec.maxAmount != null) bits.push(`under ₹${spec.maxAmount}`)
  if (spec.from || spec.to) bits.push(`${spec.from ?? 'the start'} → ${spec.to ?? 'today'}`)
  else bits.push('all time')
  void methods
  return bits.join(' · ')
}
