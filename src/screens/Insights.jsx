import { useEffect, useMemo, useRef, useState } from 'react'
import { LineChart, Line, XAxis, PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { listTransactions } from '../lib/db'
import { money, iso, today, startOfMonth, daysInMonth, dayLabel, spendTotal } from '../lib/format'
import { colorFor, allCategories } from '../lib/categories'
import { findRecurring, committedPerMonth } from '../lib/recurring'
import CategoryIcon from '../components/CategoryIcon.jsx'
import Amount from '../components/Amount.jsx'
import Skeleton, { HeroSkeleton, RowsSkeleton } from '../components/Skeleton.jsx'

// Not a dashboard of squares. Findings first, in sentences, then the numbers
// that back them. Every sentence here is arithmetic on rows already on the
// device — nothing on this screen costs an API call.

// recharts needs literal values, not var(). Read once at mount so the chart
// follows the theme instead of hardcoding one.
function palette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n) => cs.getPropertyValue(n).trim()
  return { line: v('--chart-line'), ghost: v('--chart-ghost'), rule: v('--rule'), card: v('--card') }
}

// What the donut can be pointed at. Investment sits third, after income, and
// is its own kind of money rather than a flavour of transfer — an SIP is not
// spending, and calling it one made every "where did it go" figure wrong.
const SPLITS = [
  ['expense', 'Expense'],
  ['income', 'Income'],
  ['investment', 'Investment'],
  ['transfer', 'Transfer'],
]
const SPLIT_ALL = {
  expense: 'All categories',
  income: 'All money in',
  investment: 'All invested',
  transfer: 'All transfers',
}
const SPLIT_VERB = {
  expense: 'spent',
  income: 'received',
  investment: 'invested',
  transfer: 'transferred',
}
// Only spending is worth splitting by category — that is what categories are
// for. Money in, investments and transfers all live in one or two categories
// each ('Income', 'Transfers'), so a category donut of them is a single ring in
// a single colour saying nothing. Split those by who the money went to or came
// from instead.
const SPLIT_BY = { expense: 'category', income: 'merchant', investment: 'merchant', transfer: 'merchant' }

/**
 * Slice colours.
 *
 * A category's own colour is the right answer when it has one and it is
 * distinct. Two of the fourteen are deliberately neutral — Transfers #D0D5CE
 * and Other #E7E7E1 — which is correct beside a bright category and useless as
 * a whole ring; and a category the user invented can pick a hex a built-in
 * already owns, so two slices come out identical. Anything neutral, repeated,
 * or absent falls through to the next unused hue.
 */
const WHEEL = [
  '#FFC091', '#9FE870', '#A0E1E1', '#FFD7EF', '#FADC65', '#C6A8D9',
  '#51C8C8', '#FF8787', '#C5EDAB', '#FFEB69', '#77D4D4', '#FFA8AD',
]
const NEUTRALS = new Set(['#D0D5CE', '#E7E7E1'])
// A literal, not var(--rule-strong): recharts writes fill as an SVG attribute,
// and a translucent rule colour drew the swept-up remainder as a ghost of a
// slice that was often a tenth of the month.
const REST_COLOR = '#AEB3A9'

function paint(slices, byCategory) {
  const used = new Set()
  return slices.map((s) => {
    if (s.name === 'Everything else') return { ...s, color: REST_COLOR }
    let c = byCategory ? colorFor(s.category ?? s.name)?.toUpperCase() : null
    if (!c || NEUTRALS.has(c) || used.has(c)) {
      c = WHEEL.find((w) => !used.has(w)) ?? REST_COLOR
    }
    used.add(c)
    return { ...s, color: c }
  })
}

const dayNum = (d) => Number(String(d).slice(8, 10))
// Read once, not per row — a category the user invented is a real category here
// and localStorage inside a reduce is a synchronous disk hit per transaction.
let KNOWN = new Set(allCategories())
const catOf = (r) => (KNOWN.has(r.category) ? r.category : 'Other')

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// findRecurring has no notion of recency: a service cancelled in April still
// has its three sightings inside the six-month window and still reads as
// "monthly" in August. Anything whose next payment came and went more than a
// full cycle ago has lapsed — it is not committed money, and showing its stale
// due date as "next around" states a past date as the future.
const CYCLE_DAYS = { weekly: 7, fortnightly: 14, monthly: 30.4, quarterly: 91, yearly: 365 }
// Both sides parse as UTC midnight, so the difference is exact whole days.
const daysSince = (date) => (Date.parse(today()) - Date.parse(date)) / 86400000
const hasLapsed = (f) => daysSince(f.next) > (CYCLE_DAYS[f.cadence] ?? 30.4)

const Rs = ({ n, className = '' }) => (
  <span className={`num ${className}`.trim()}>
    <span className="rupee">₹</span>
    {money(n)}
  </span>
)


/** Hold the old value until the blur has covered it, then swap. A straight
 *  crossfade shows two texts overlapping; blur bridges them into one change.
 *
 *  Keyed off `value` alone. Depending on `shown` — which this effect also sets —
 *  meant the loop was held open only by an equality guard, one added branch away
 *  from re-running itself forever. A ref skips the mount pass instead, which is
 *  the only thing that guard was really for. */
function useBlurSwap(value, ms = 160) {
  const [shown, setShown] = useState(value)
  const [swapping, setSwapping] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true // first paint is not a change, so nothing to blur over
      return
    }
    setSwapping(true)
    const t = setTimeout(() => {
      setShown(value)
      setSwapping(false)
    }, ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return [shown, swapping]
}

/** Findings, in priority order. Only ones the data actually supports get made —
 *  a "noticed" block that fires on noise teaches the user to ignore the box. */
function findings({ cats, merchants, projected, prevTotal, dom, dim }) {
  const out = []

  const hot = cats
    .filter((c) => c.prevMTD > 0 && c.amt > c.prevMTD * 1.25 && c.amt >= 500)
    .sort((a, b) => b.amt - b.prevMTD - (a.amt - a.prevMTD))[0]
  if (hot) {
    const pct = Math.round(((hot.amt - hot.prevMTD) / hot.prevMTD) * 100)
    out.push({
      k: 'Trending up',
      text: (
        <>
          <b>{hot.name}</b> is {pct}% higher than the same stretch of last month —{' '}
          <Rs n={hot.amt} /> against <Rs n={hot.prevMTD} />.
        </>
      ),
    })
  }

  const habit = merchants.filter((m) => m.count >= 4)[0]
  if (habit) {
    const each = habit.total / habit.count
    const monthly = each * (habit.count / Math.max(dom, 1)) * dim
    out.push({
      k: 'A habit',
      text: (
        <>
          <b>{habit.name}</b> {habit.count} times this month, <Rs n={each} /> a go. At this rate
          it&rsquo;s <Rs n={monthly} /> by month end.
        </>
      ),
    })
  }

  if (prevTotal > 0) {
    const delta = projected - prevTotal
    const pct = Math.round((Math.abs(delta) / prevTotal) * 100)
    if (pct >= 10) {
      out.push({
        k: 'Pace',
        text: (
          <>
            You&rsquo;re on track to finish <Rs n={Math.abs(delta)} /> ({pct}%){' '}
            {delta > 0 ? 'over' : 'under'} last month.
          </>
        ),
      })
    }
  }

  return out.slice(0, 3)
}

/** The way into Ask. Sits above the month, because a question you already have
 *  beats a chart you have to interpret. */
const AskBar = ({ onClick }) => (
  <button className="askentry" onClick={onClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
    <span>Ask about your money…</span>
  </button>
)

export default function Insights({ goAsk }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [c] = useState(palette)
  const [active, setActive] = useState(null) // index into the donut slices
  const [split, setSplit] = useState('expense') // which kind of money the donut shows

  useEffect(() => {
    let live = true
    // Refreshed per mount — the screen is unmounted when you leave the tab, so
    // a category invented in the picker is known by the time you come back.
    KNOWN = new Set(allCategories())
    const now = new Date()
    // Six months, not two: a monthly subscription needs three sightings before
    // it can be told apart from a coincidence. The month-over-month figures
    // below filter down to their own windows regardless.
    const from = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 5, 1))
    setErr('')
    listTransactions({ from, to: today(), limit: 3000 })
      .then((data) => live && setRows(data))
      .catch((e) => {
        console.error(e)
        // Never [] here. An empty array is a claim — "you spent nothing this
        // month" — and a dropped connection is not entitled to make it.
        if (live) setErr(e.message ?? String(e))
      })
    return () => {
      live = false
    }
  }, [attempt])

  const d = useMemo(() => {
    const now = new Date()
    const monthStart = startOfMonth(now)
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevStart = startOfMonth(prevDate)
    const dim = daysInMonth(now)
    const prevDim = daysInMonth(prevDate)
    const dom = now.getDate()

    // Every number below is spend-only. Transfers, income, lent, repaid never count.
    // monthCount is the exception: it counts rows of any type, because a month
    // of nothing but salary has plenty logged and no spending.
    const monthCount = (rows ?? []).filter((r) => r.txn_date >= monthStart).length
    const spend = (rows ?? []).filter((r) => r.type === 'expense')
    const cur = spend.filter((r) => r.txn_date >= monthStart)
    const prev = spend.filter((r) => r.txn_date >= prevStart && r.txn_date < monthStart)
    // Last month cut at the same day of the month — the only fair comparison
    // for a percentage.
    const prevSoFar = prev.filter((r) => dayNum(r.txn_date) <= dom)

    const perDay = (list, n) => {
      const a = new Array(n + 2).fill(0)
      for (const r of list) a[dayNum(r.txn_date)] += Number(r.amount)
      return a
    }
    const curDays = perDay(cur, dim)
    const prevDays = perDay(prev, prevDim)

    let a = 0
    let b = 0
    const line = []
    for (let i = 1; i <= dom; i++) {
      a += curDays[i] || 0
      b += prevDays[i] || 0
      line.push({ day: i, now: a, prev: b })
    }

    const mtd = spendTotal(cur)
    const prevTotal = spendTotal(prev)
    const projected = dom ? (mtd / dom) * dim : 0

    const totals = (list) => {
      const m = new Map()
      for (const r of list) {
        const cat = catOf(r)
        m.set(cat, (m.get(cat) ?? 0) + Number(r.amount))
      }
      return m
    }
    const curCats = totals(cur)
    const prevMTDCats = totals(prevSoFar)
    const ranked = [...curCats.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([name, amt]) => ({ name, amt, prevMTD: prevMTDCats.get(name) ?? 0 }))

    // Six slices plus a swept-up remainder. Past that a donut is confetti.
    const cats = ranked.slice(0, 6)
    const rest = ranked.slice(6).reduce((s, x) => s + x.amt, 0)

    // The split, per kind of money. Spending is the default view; the other
    // three are the same arithmetic over a different set of types, so the donut
    // can answer "where did my income come from" and "what did I put away"
    // without a second screen.
    const curAll = (rows ?? []).filter((r) => r.txn_date >= monthStart)
    const splitFor = (types, by) => {
      const list = curAll.filter((r) => types.includes(r.type))
      const sum = list.reduce((s, r) => s + Number(r.amount || 0), 0)
      const m = new Map()
      for (const r of list) {
        // The category rides along whatever we grouped by, because it is what
        // picks the glyph in the legend.
        const key = by === 'merchant' ? r.payee_clean || r.payee_raw || 'Unknown' : catOf(r)
        const g = m.get(key) ?? { name: key, amt: 0, category: catOf(r), prevMTD: 0 }
        g.amt += Number(r.amount || 0)
        m.set(key, g)
      }
      const ranked2 = [...m.values()].sort((x, y) => y.amt - x.amt)
      const top = ranked2.slice(0, 6)
      const other = ranked2.slice(6).reduce((s, x) => s + x.amt, 0)
      const slices = other > 0 ? [...top, { name: 'Everything else', amt: other, category: 'Other', prevMTD: 0 }] : top
      return { total: sum, count: list.length, slices: paint(slices, by === 'category') }
    }
    const expenseSlices = rest > 0 ? [...cats, { name: 'Everything else', amt: rest, prevMTD: 0 }] : cats
    const splits = {
      expense: { total: spendTotal(cur), count: cur.length, slices: paint(expenseSlices, true) },
      income: splitFor(['income', 'refund', 'repaid'], SPLIT_BY.income),
      investment: splitFor(['investment'], SPLIT_BY.investment),
      transfer: splitFor(['transfer', 'lent'], SPLIT_BY.transfer),
    }

    const byMerchant = new Map()
    for (const r of cur) {
      const name = r.payee_clean || r.payee_raw
      const g = byMerchant.get(name) ?? { name, count: 0, total: 0, category: catOf(r) }
      g.count += 1
      g.total += Number(r.amount)
      byMerchant.set(name, g)
    }
    const merchants = [...byMerchant.values()]
      .filter((m) => m.count > 1)
      .sort((x, y) => y.count - x.count || y.total - x.total)
      .slice(0, 6)

    const dayMax = Math.max(1, ...curDays)
    const strip = []
    for (let i = 1; i <= dim; i++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), i)
      const wd = dt.getDay()
      strip.push({
        day: i,
        amt: curDays[i] || 0,
        pct: Math.round(((curDays[i] || 0) / dayMax) * 100),
        isToday: iso(dt) === today(),
        weekend: wd === 0 || wd === 6,
      })
    }
    const busiest = strip.reduce((best, x) => (x.amt > (best?.amt ?? 0) ? x : best), null)

    const cutoffs = new Map()
    for (const [cat] of curCats) {
      cutoffs.set(cat, 2 * median(cur.filter((r) => catOf(r) === cat).map((r) => Number(r.amount))))
    }
    const unusual = cur
      .filter((r) => Number(r.amount) > cutoffs.get(catOf(r)))
      .sort((x, y) => Number(y.amount) - Number(x.amount))
      .slice(0, 5)

    // Over the whole six months, not just this one — three sightings is the floor.
    // Split, though: a bill that stopped charging is history, not commitment.
    const found = findRecurring(spend)
    const recurring = found.filter((f) => !hasLapsed(f))
    const lapsed = found.filter(hasLapsed)

    return {
      dim, dom, line, mtd, prevTotal, projected, monthCount, splits,
      cats: ranked.slice(0, 8), merchants, strip, busiest, unusual, recurring, lapsed,
    }
  }, [rows])

  const [shownActive, swapping] = useBlurSwap(active)

  // Before the skeleton: a failure has to say so. Falling through to "nothing
  // logged" would have the app confidently report a ₹0 month off a dropped
  // connection, which is the one thing an expense tracker must never do.
  if (err) {
    return (
      <div className="screen">
        <p className="eyebrow">Insights</p>
        <h1 className="title">Couldn&rsquo;t read your month</h1>
        <div className="card">
          <p className="empty" style={{ paddingBottom: 10 }}>
            Your transactions didn&rsquo;t load, so there are no numbers to show — this is not
            an empty month.
          </p>
          <p className="alert" style={{ fontSize: 13, textAlign: 'center', margin: '0 0 16px' }}>{err}</p>
          <p style={{ textAlign: 'center', margin: '0 0 24px' }}>
            <button className="btn ghost small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      </div>
    )
  }

  if (!rows) {
    return (
      <div className="screen" role="status" aria-label="Loading your month">
        <p className="eyebrow">Insights</p>
        <h1 className="title">Where your money actually went</h1>
        <Skeleton h={54} style={{ marginBottom: 14, borderRadius: 'var(--radius-pill)' }} />
        <HeroSkeleton />
        <div className="tiles" style={{ marginTop: 14 }}>
          <Skeleton h={76} />
          <Skeleton h={76} />
        </div>
        <h2 className="section">The split</h2>
        <Skeleton h={300} />
        <h2 className="section">Against last month</h2>
        <Skeleton h={210} />
        <h2 className="section">Repeats</h2>
        <RowsSkeleton rows={3} />
      </div>
    )
  }

  // Rows, not rupees. A month of nothing but salary has plenty logged, and
  // telling its owner "nothing logged yet" is simply wrong.
  if (d.monthCount === 0) {
    return (
      <div className="screen">
        <p className="eyebrow">Insights</p>
        <h1 className="title">Where did your money actually go?</h1>
        <div className="card">
          <p className="empty">Nothing logged yet this month. Ask again in a few days.</p>
        </div>
      </div>
    )
  }

  // Logged, but none of it spending *or* anything else the split can show.
  // A month of one salary and one SIP has plenty to look at, and bailing here
  // used to make the new Income and Investment views unreachable in exactly the
  // month they were most worth having.
  const otherMoney =
    d.splits.income.count + d.splits.investment.count + d.splits.transfer.count
  if (d.mtd === 0 && otherMoney === 0) {
    return (
      <div className="screen">
        <p className="eyebrow">Insights</p>
        <h1 className="title">Nothing spent yet this month</h1>
        <div className="card">
          <p className="empty">
            {d.monthCount} thing{d.monthCount === 1 ? '' : 's'} logged so far, none of it
            spending. The charts start once money goes out.
          </p>
        </div>
      </div>
    )
  }

  const notes = findings(d)
  const ticks = [...new Set([1, Math.round(d.dom / 2), d.dom])].filter((t) => t >= 1)
  // A tab with nothing in it falls through to the first that has something,
  // rather than drawing a ring of nothing on the month's opening days.
  const activeSplit =
    d.splits[split].count > 0 ? split : (SPLITS.find(([id]) => d.splits[id].count > 0)?.[0] ?? 'expense')
  const shownSplit = d.splits[activeSplit]
  const picked = shownActive == null ? null : shownSplit.slices[shownActive]

  return (
    <div className="screen">
      <div className="stagger">
        <p className="eyebrow">
          This month, day {d.dom} of {d.dim}
        </p>
        <h1 className="title">Where your money actually went</h1>

        <AskBar onClick={goAsk} />

        <div className="brand">
          <p className="caption">Spent so far</p>
          <Amount value={d.mtd} className="amount" />
          <hr />
          <div className="foot">
            <div>
              <span className="k">At this rate</span>
              <b className="num">₹{money(d.projected)}</b>
            </div>
            {/* No last month, no comparison. A ₹0 sitting under a label reads
                as a real figure rather than an absence. */}
            {d.prevTotal > 0 && (
              <div>
                <span className="k">Last month</span>
                <b className="num">₹{money(d.prevTotal)}</b>
              </div>
            )}
          </div>
        </div>

        <div className="tiles">
          <div className="card">
            <div className="k">Daily average</div>
            <div className="v num">₹{money(d.mtd / d.dom)}</div>
          </div>
          <div className="card">
            <div className="k">Busiest day</div>
            <div className="v num">₹{money(d.busiest?.amt ?? 0)}</div>
          </div>
        </div>

        {notes.length > 0 && (
          <div>
            {notes.map((n) => (
              <div className="noticed" key={n.k}>
                <div className="body">
                  <span className="k">{n.k}</span>
                  <p>{n.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="section">The split</h2>
      <div className="chips" role="tablist" aria-label="What the split shows">
        {SPLITS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeSplit === id}
            disabled={d.splits[id].count === 0}
            onClick={() => {
              setSplit(id)
              setActive(null)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="card-body" style={{ paddingBottom: 6 }}>
          {shownSplit.slices.length === 0 ? (
            <p className="empty">Nothing {SPLIT_VERB[activeSplit]} this month.</p>
          ) : (
          <>
          <div className="donut">
            <ResponsiveContainer width="100%" height={224}>
              <PieChart>
                <Pie
                  data={shownSplit.slices}
                  dataKey="amt"
                  nameKey="name"
                  innerRadius="66%"
                  outerRadius="100%"
                  paddingAngle={2.5}
                  cornerRadius={7}
                  stroke="none"
                  startAngle={90}
                  endAngle={-270}
                  // No sweep-in. Webfonts landing after mount resize the
                  // container, recharts restarts the entrance from radius 0,
                  // and the ring can sit there empty. A chart has to be
                  // readable immediately; the motion that earns its keep here
                  // is the selection fade below, not a reveal.
                  isAnimationActive={false}
                  onClick={(_, i) => setActive((a) => (a === i ? null : i))}
                >
                  {shownSplit.slices.map((s, i) => (
                    <Cell
                      key={s.name}
                      fill={s.color}
                      // Dimming the rest is the selection. No exploding slices —
                      // a segment that jumps out moves the whole ring's balance.
                      opacity={active == null || active === i ? 1 : 0.28}
                      style={{ transition: 'opacity 200ms cubic-bezier(0.23,1,0.32,1)', cursor: 'pointer' }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>

            <div className="centre">
              <div className="swap" data-swapping={swapping}>
                <div className="k">{picked ? picked.name : SPLIT_ALL[activeSplit]}</div>
                <div className="v num">₹{money(picked ? picked.amt : shownSplit.total)}</div>
                {picked && (
                  <div className="k" style={{ marginTop: 4 }}>
                    {Math.round((picked.amt / (shownSplit.total || 1)) * 100)}% of the month
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="legend" style={{ marginTop: 8 }}>
            {shownSplit.slices.map((s, i) => (
              <button
                key={s.name}
                data-active={active === i}
                onClick={() => setActive((a) => (a === i ? null : i))}
              >
                {/* The slice's colour, not the category's — otherwise the tile
                    and the arc it points at disagree the moment a colour was
                    reassigned for being neutral or a repeat. */}
                <CategoryIcon category={s.category ?? s.name} color={s.color} />
                <span className="nm">{s.name}</span>
                <span className="pc">{Math.round((s.amt / (shownSplit.total || 1)) * 100)}%</span>
                <span className="vl num">₹{money(s.amt)}</span>
              </button>
            ))}
          </div>
          </>
          )}
        </div>
      </div>

      <h2 className="section">Against last month</h2>
      <div className="card">
        <div className="card-body">
          <ResponsiveContainer width="100%" height={168}>
            <LineChart data={d.line} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="day"
                ticks={ticks}
                tick={{ fill: c.ghost, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: c.rule }}
              />
              <Line
                type="monotone"
                dataKey="prev"
                stroke={c.ghost}
                strokeWidth={1.5}
                strokeDasharray="3 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="now"
                stroke={c.line}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            <span>
              <b style={{ color: c.line }}>—</b> this month <Rs n={d.mtd} />
            </span>
            <span>
              <b>--</b> same day last month <Rs n={d.line.at(-1)?.prev ?? 0} />
            </span>
          </div>
        </div>
      </div>

      <h2 className="section">Every day this month</h2>
      <div className="card">
        <div className="card-body">
          <div className="strip">
            {d.strip.map((b) => (
              <div
                key={b.day}
                title={`${b.day}: ₹${money(b.amt)}`}
                className={`bar${b.amt > 0 ? ' has' : ''}${b.isToday ? ' today' : ''}${b.weekend ? ' weekend' : ''}`}
                style={{ height: `${Math.max(b.pct, 3)}%` }}
              />
            ))}
          </div>
          <div className="striplabels">
            <span>1</span>
            <span>{d.dim}</span>
          </div>
        </div>
      </div>

      {d.recurring.length > 0 && (
        <>
          <h2 className="section">Recurring</h2>
          <div className="card">
            <div className="card-head">
              <span>Committed every month</span>
              <span className="num">₹{money(committedPerMonth(d.recurring))}</span>
            </div>
            <ul className="ledger">
              {d.recurring.slice(0, 8).map((f) => (
                <li key={f.name}>
                  <div className="row">
                    <CategoryIcon category={f.category} />
                    <div className="who">
                      <div className="name">{f.name}</div>
                      <div className="meta">
                        {f.cadence} · next around {dayLabel(f.next)}
                      </div>
                    </div>
                    <div className="amt">
                      <Rs n={f.amount} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {d.lapsed.length > 0 && (
        <>
          <h2 className="section">Looks cancelled</h2>
          <div className="card">
            <div className="card-head">
              <span>Was costing you</span>
              <span className="num">₹{money(committedPerMonth(d.lapsed))}</span>
            </div>
            <ul className="ledger">
              {d.lapsed.slice(0, 8).map((f) => (
                <li key={f.name}>
                  <div className="row">
                    <CategoryIcon category={f.category} />
                    <div className="who">
                      <div className="name">{f.name}</div>
                      <div className="meta">
                        {f.cadence} · nothing since {dayLabel(f.last)}
                      </div>
                    </div>
                    <div className="amt">
                      <Rs n={f.amount} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
            These charged on a schedule and then stopped. Nothing here counts as money
            you are still committed to.
          </p>
        </>
      )}

      {d.merchants.length > 0 && (
        <>
          <h2 className="section">Repeats</h2>
          <div className="card">
            <ul className="ledger">
              {d.merchants.map((m) => (
                <li key={m.name}>
                  <div className="row">
                    <CategoryIcon category={m.category} />
                    <div className="who">
                      <div className="name">{m.name}</div>
                      <div className="meta">{m.count} times</div>
                    </div>
                    <div className="amt">
                      <Rs n={m.total} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {d.unusual.length > 0 && (
        <>
          <h2 className="section">Bigger than usual</h2>
          <div className="card">
            <ul className="ledger">
              {d.unusual.map((r) => (
                <li key={r.id}>
                  <div className="row flagged">
                    <CategoryIcon category={catOf(r)} />
                    <div className="who">
                      <div className="name">{r.payee_clean || r.payee_raw}</div>
                      <div className="meta">
                        {catOf(r)} · {dayLabel(r.txn_date)}
                      </div>
                    </div>
                    <div className="amt">
                      <Rs n={r.amount} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
