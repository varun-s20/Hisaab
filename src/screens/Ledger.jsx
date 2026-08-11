import { useEffect, useMemo, useState } from 'react'
import { listTransactions } from '../lib/db'
import { money, dayLabel, startOfMonth, today, spendTotal } from '../lib/format'
import { Row } from './Today.jsx'

// The ledger proper: every row, newest first, grouped by day.
// Hairline rules, merchant left, amount right in tabular figures. No cards.

export default function Ledger({ onChange }) {
  const [rows, setRows] = useState([])
  const [months, setMonths] = useState(1)
  const [loaded, setLoaded] = useState(false)

  const from = useMemo(() => {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - (months - 1))
    return startOfMonth(d)
  }, [months])

  async function load() {
    const r = await listTransactions({ from, to: today(), limit: 1000 })
    setRows(r)
    setLoaded(true)
  }

  useEffect(() => {
    load().catch(() => setLoaded(true))
  }, [from])

  const groups = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      if (!m.has(r.txn_date)) m.set(r.txn_date, [])
      m.get(r.txn_date).push(r)
    }
    return [...m.entries()]
  }, [rows])

  async function refresh() {
    await load()
    onChange?.()
  }

  return (
    <div className="screen">
      <h1 className="title">Ledger</h1>

      {loaded && rows.length === 0 && <p className="empty">Nothing logged yet.</p>}

      {groups.map(([date, list]) => (
        <div className="daygroup" key={date}>
          <div className="head">
            <span>{dayLabel(date)}</span>
            <span className="num">
              <span className="rupee">₹</span>
              {money(spendTotal(list))}
            </span>
          </div>
          <ul className="ledger">
            {list.map((r) => (
              <Row key={r.id} r={r} onChange={refresh} />
            ))}
          </ul>
        </div>
      ))}

      {loaded && rows.length > 0 && (
        <p style={{ textAlign: 'center', marginTop: 22 }}>
          <button className="linkish" onClick={() => setMonths((m) => m + 1)}>
            Load earlier
          </button>
        </p>
      )}
    </div>
  )
}
