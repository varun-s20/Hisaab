import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, ResponsiveContainer } from 'recharts'
import { listTransactions } from '../lib/db'
import { money, iso, today, startOfMonth, daysInMonth, dayLabel, spendTotal } from '../lib/format'
import { colorFor, CATEGORIES } from '../lib/categories'

// recharts needs literal values, not var(). Keep in sync with styles.css.
const OUT = '#E8A33D'
const MUTED = '#8A8F94'
const RULE = '#262A2E'

const dayNum = (d) => Number(String(d).slice(8, 10))
const catOf = (r) => (CATEGORIES.includes(r.category) ? r.category : 'Other')

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const Rs = ({ n, className = '' }) => (
  <span className={`num ${className}`.trim()}>
    <span className="rupee">₹</span>
    {money(n)}
  </span>
)

const Skeleton = ({ h }) => (
  <div style={{ height: h, background: 'var(--surface)', borderRadius: 'var(--radius)', marginBottom: 12 }} />
)

export default function Insights() {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let live = true
    const now = new Date()
    const from = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1))
    listTransactions({ from, to: today() })
      .then((d) => live && setRows(d))
      .catch((e) => {
        console.error(e)
        if (live) setRows([])
      })
    return () => {
      live = false
    }
  }, [])

  const d = useMemo(() => {
    const now = new Date()
    const monthStart = startOfMonth(now)
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevStart = startOfMonth(prevDate)
    const dim = daysInMonth(now)
    const prevDim = daysInMonth(prevDate)
    const dom = now.getDate()

    // Every number below is spend-only. Transfers, income, lent, repaid never count.
    const spend = (rows ?? []).filter((r) => r.type === 'expense')
    const cur = spend.filter((r) => r.txn_date >= monthStart)
    const prev = spend.filter((r) => r.txn_date >= prevStart && r.txn_date < monthStart)

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
        const c = catOf(r)
        m.set(c, (m.get(c) ?? 0) + Number(r.amount))
      }
      return m
    }
    const curCats = totals(cur)
    const prevCats = totals(prev)
    const cats = [...curCats.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([name, amt]) => ({ name, amt, ghost: prevCats.get(name) ?? 0 }))
    const catMax = Math.max(1, ...cats.map((c) => Math.max(c.amt, c.ghost)))

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

    const cutoffs = new Map()
    for (const [c] of curCats) {
      cutoffs.set(c, 2 * median(cur.filter((r) => catOf(r) === c).map((r) => Number(r.amount))))
    }
    const unusual = cur
      .filter((r) => Number(r.amount) > cutoffs.get(catOf(r)))
      .sort((x, y) => Number(y.amount) - Number(x.amount))
      .slice(0, 5)

    return { dim, dom, line, mtd, prevTotal, projected, cats, catMax, merchants, strip, unusual }
  }, [rows])

  if (!rows) {
    return (
      <div className="screen">
        <p className="eyebrow">Insights</p>
        <Skeleton h={170} />
        <Skeleton h={120} />
        <Skeleton h={190} />
      </div>
    )
  }

  if (d.mtd === 0) {
    return (
      <div className="screen">
        <p className="eyebrow">Insights</p>
        <p className="empty">Nothing logged yet this month.</p>
      </div>
    )
  }

  const delta = d.projected - d.prevTotal
  const ticks = [...new Set([1, Math.round(d.dom / 2), d.dom])].filter((t) => t >= 1)

  return (
    <div className="screen">
      <p className="eyebrow">Insights</p>

      <h2 className="section" style={{ marginTop: 0 }}>
        Month to date
      </h2>
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={d.line} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
          <XAxis
            dataKey="day"
            ticks={ticks}
            tick={{ fill: MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: RULE }}
          />
          <Line
            type="monotone"
            dataKey="prev"
            stroke={MUTED}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="now"
            stroke={OUT}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: MUTED, marginTop: 2 }}>
        <span>
          <b style={{ color: OUT }}>—</b> this month <Rs n={d.mtd} />
        </span>
        <span>
          <b>--</b> same day last month <Rs n={d.line.at(-1)?.prev ?? 0} />
        </span>
      </div>

      <div className="hero">
        <div className="amount num out">
          <span className="rupee">₹</span>
          {money(d.projected)}
        </div>
        <div className="label">
          Projected month-end
          {d.prevTotal > 0 && (
            <>
              {' · '}
              <Rs n={Math.abs(delta)} /> {delta >= 0 ? 'over' : 'under'} last month
            </>
          )}
        </div>
      </div>

      <h2 className="section">Categories</h2>
      {d.cats.map((c) => {
        const colour = colorFor(c.name)
        return (
          <div key={c.name} style={{ marginBottom: 11 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 10,
                marginBottom: 5,
                fontSize: 14,
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}
              </span>
              <Rs n={c.amt} />
            </div>
            <div style={{ position: 'relative', height: 8, borderRadius: 2, background: 'var(--rule)' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${(c.ghost / d.catMax) * 100}%`,
                  background: colour,
                  opacity: 0.26,
                  borderRadius: 2,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${(c.amt / d.catMax) * 100}%`,
                  background: colour,
                  borderRadius: 2,
                }}
              />
            </div>
          </div>
        )
      })}

      {d.merchants.length > 0 && (
        <>
          <h2 className="section">Repeats</h2>
          <ul className="ledger">
            {d.merchants.map((m) => (
              <li className="row" key={m.name}>
                <i className="dot" style={{ background: colorFor(m.category) }} />
                <div className="who">
                  <div className="name">{m.name}</div>
                  <div className="meta">{m.count} times</div>
                </div>
                <div className="amt">
                  <Rs n={m.total} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="section">Daily</h2>
      <div className="strip">
        {d.strip.map((b) => (
          <div
            key={b.day}
            className={`bar${b.amt > 0 ? ' has' : ''}${b.isToday ? ' today' : ''}${b.weekend ? ' weekend' : ''}`}
            style={{ height: `${b.pct}%` }}
          />
        ))}
      </div>
      <div className="striplabels">
        <span>1</span>
        <span>{d.dim}</span>
      </div>

      {d.unusual.length > 0 && (
        <>
          <h2 className="section">Unusual</h2>
          <ul className="ledger">
            {d.unusual.map((r) => (
              <li className="row flagged" key={r.id}>
                <i className="dot" style={{ background: colorFor(catOf(r)) }} />
                <div className="who">
                  <div className="name">{r.payee_clean || r.payee_raw}</div>
                  <div className="meta">
                    {catOf(r)} · {dayLabel(r.txn_date)}
                  </div>
                </div>
                <div className="amt">
                  <Rs n={r.amount} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
