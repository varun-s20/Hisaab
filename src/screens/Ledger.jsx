import { useEffect, useMemo, useState } from 'react'
import { listTransactions } from '../lib/db'
import { money, dayLabel, today, spendTotal, earnTotal, investTotal } from '../lib/format'
import { makeRange } from '../lib/range'
import RangePicker from '../components/RangePicker.jsx'
import { Bar, RowsSkeleton } from '../components/Skeleton.jsx'
import { Row } from './Today.jsx'

// The ledger proper. One card per day, hairlines inside it — the card is what
// gives a light theme its structure, since a page of naked rules on white reads
// as a spreadsheet.

const FILTERS = [
  ['all', 'Everything'],
  ['out', 'Money out'],
  ['in', 'Money in'],
]

const isOut = (r) => r.type === 'expense'
const isIn = (r) => r.type === 'income' || r.type === 'refund' || r.type === 'repaid'

function csv(rows) {
  const head = ['date', 'time', 'payee', 'category', 'type', 'direction', 'amount']
  // Quoting stops the field breaking the row; it does not stop Excel and
  // LibreOffice evaluating one that opens with a formula lead-in. A payee is
  // whatever name the other side typed into their own UPI app, read off a
  // screenshot, so =HYPERLINK(...) is a thing that can arrive. The apostrophe
  // makes the cell text, which is all these ever were.
  const esc = (v) => {
    const s = String(v ?? '')
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
  }
  const body = rows.map((r) =>
    [r.txn_date, r.txn_time ?? '', r.payee_clean || r.payee_raw, r.category ?? '', r.type, r.direction, r.amount]
      .map(esc)
      .join(','),
  )
  return [head.join(','), ...body].join('\n')
}

export default function Ledger({ onChange }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(today)
  const [custom, setCustom] = useState({ from: today(), to: today() })
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)

  const range = useMemo(() => makeRange(mode, anchor, custom), [mode, anchor, custom])

  const fetchRows = () => listTransactions({ from: range.from, to: range.to, limit: 2000 })

  useEffect(() => {
    // Three taps on the previous-period arrow start three queries, and on a slow
    // connection they don't come back in order — the oldest landing last leaves
    // May's label over June's rows. Same live flag as Insights and Review.
    let live = true
    setLoaded(false)
    fetchRows()
      .then((r) => {
        if (!live) return
        setRows(r)
        setLoaded(true)
      })
      .catch(() => live && setLoaded(true))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to])

  // Totals track the range, not the filter — switching to "Money in" is a way
  // of reading the list, not a claim that the month had no spending.
  const totals = useMemo(
    () => ({ out: spendTotal(rows), in: earnTotal(rows), invested: investTotal(rows) }),
    [rows],
  )

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'out' && !isOut(r)) return false
      if (filter === 'in' && !isIn(r)) return false
      if (!needle) return true
      return `${r.payee_clean ?? ''} ${r.payee_raw ?? ''} ${r.category ?? ''}`.toLowerCase().includes(needle)
    })
  }, [rows, filter, q])

  const groups = useMemo(() => {
    const m = new Map()
    for (const r of shown) {
      if (!m.has(r.txn_date)) m.set(r.txn_date, [])
      m.get(r.txn_date).push(r)
    }
    return [...m.entries()]
  }, [shown])

  async function refresh() {
    setRows(await fetchRows())
    onChange?.()
  }

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([csv(shown)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `hisaab-${range.from}-to-${range.to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="screen">
      <h1 className="title">Ledger</h1>

      <RangePicker
        mode={mode}
        setMode={setMode}
        anchor={anchor}
        setAnchor={setAnchor}
        custom={custom}
        setCustom={setCustom}
        range={range}
      />

      {/* `rows` still holds the previous period until the new one lands, so
          these three figures would otherwise state last month's totals under
          this month's heading for as long as the request takes. */}
      <div className="totals card">
        {['Money out', 'Money in', 'Net'].map((k, i) => (
          <div key={k}>
            <span className="k">{k}</span>
            {loaded ? (
              <span className={`v num ${i === 0 ? 'out' : i === 1 ? 'in' : ''}`.trim()}>
                {i === 0 && `₹${money(totals.out)}`}
                {i === 1 && `₹${money(totals.in)}`}
                {i === 2 &&
                  `${totals.in - totals.out < 0 ? '−' : ''}₹${money(Math.abs(totals.in - totals.out))}`}
              </span>
            ) : (
              <Bar h={20} w="80%" style={{ marginTop: 5 }} />
            )}
          </div>
        ))}
      </div>

      {/* A fourth column would clip a six-figure number on a 320px phone, and
          leaving it out entirely made an SIP invisible in every figure on the
          screen while plainly sitting in the list below. */}
      {totals.invested > 0 && (
        <p className="muted" style={{ fontSize: 12.5, margin: '-6px 2px 12px' }}>
          Plus <span className="num">₹{money(totals.invested)}</span> into investments — out
          of the account, but not spent, so it is in neither figure above.
        </p>
      )}

      <div className="chips" role="tablist" aria-label="Show">
        {FILTERS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      <div className="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search merchant or category"
          aria-label="Search transactions"
        />
        {q && (
          <button className="iconbtn sm" aria-label="Clear search" onClick={() => setQ('')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {/* Stepping back a month over a slow connection used to leave the whole
          page below the search box blank, which is indistinguishable from a
          month with nothing in it. */}
      {!loaded && (
        <div role="status" aria-label="Loading transactions">
          <RowsSkeleton rows={3} head />
          <RowsSkeleton rows={2} head />
        </div>
      )}

      {loaded && shown.length === 0 && (
        <div className="card">
          <p className="empty">
            {rows.length === 0 ? `Nothing logged in ${range.label.toLowerCase()}.` : 'Nothing matches that.'}
          </p>
        </div>
      )}

      {loaded && groups.map(([date, list]) => (
        <div className="card" key={date}>
          {/* The card above is scoped to the range on purpose; this one is scoped
              to the rows printed under it, which is a different promise. Summing
              spend under "Money in" put ₹0 over a day of real credits. */}
          <div className="card-head">
            <span>{dayLabel(date)}</span>
            <span className="num">₹{money(filter === 'in' ? earnTotal(list) : spendTotal(list))}</span>
          </div>
          <ul className="ledger">
            {list.map((r) => (
              <Row key={r.id} r={r} onChange={refresh} />
            ))}
          </ul>
        </div>
      ))}

      {loaded && shown.length > 0 && (
        <p style={{ textAlign: 'center', marginTop: 22 }}>
          <button className="linkish quiet" onClick={exportCsv}>
            Export {shown.length} row{shown.length === 1 ? '' : 's'} as CSV
          </button>
        </p>
      )}
    </div>
  )
}
