import { useEffect, useMemo, useState } from 'react'
import { deleteTransactions, listAccounts, listMethods, listTransactions, updateTransactions } from '../lib/db'
import { money, dayLabel, today, spendTotal, earnTotal, investTotal } from '../lib/format'
import { TYPE_OPTIONS, DIRECTIONS } from '../lib/categories'
import { download, toCSV } from '../lib/csv'
import { bulkPatch } from '../lib/entry'
import { makeRange } from '../lib/range'
import CategoryPicker from '../components/CategoryPicker.jsx'
import RangePicker from '../components/RangePicker.jsx'
import Select from '../components/Select.jsx'
import Sheet from '../components/Sheet.jsx'
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

export default function Ledger({ onChange }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(today)
  const [custom, setCustom] = useState({ from: today(), to: today() })
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState('')

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

  // What is selected AND still on screen. Derived rather than pruned in an
  // effect, so narrowing the search or stepping to another month can never
  // leave a count standing for rows nobody can see — every figure and every
  // action below is about the list in front of you.
  const chosen = useMemo(() => shown.filter((r) => picked.has(r.id)), [shown, picked])

  async function refresh() {
    setRows(await fetchRows())
    onChange?.()
  }

  function leaveSelection() {
    setSelecting(false)
    setPicked(new Set())
    setErr('')
  }

  function toggle(id) {
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const allChosen = shown.length > 0 && chosen.length === shown.length

  function toggleAll() {
    setPicked(allChosen ? new Set() : new Set(shown.map((r) => r.id)))
  }

  /** Run a write over the selection, then reload and drop out of selection
   *  mode. Failing leaves the selection alone — the rows are still picked and
   *  the button can be pressed again. */
  async function apply(job) {
    if (chosen.length === 0) return
    setWorking(true)
    setErr('')
    try {
      await job(chosen.map((r) => r.id))
      await refresh()
      leaveSelection()
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setWorking(false)
      setConfirming(false)
      setEditing(false)
    }
  }

  /**
   * The same writer and the same download the Import screen uses.
   *
   * This screen had a second copy of both, and the copy was worse in four ways
   * that only show up on somebody else's machine: no BOM, so Excel on Windows
   * read ₹ and every Devanagari merchant name as mojibake; an anchor that was
   * never in the document, which Safari ignores outright; the object URL revoked
   * synchronously after .click(), which races the download; and a narrower set
   * of columns, so a note and a transfer's destination were dropped. lib/csv.js
   * is also the shape lib/statement.js can read back in.
   */
  function exportCsv() {
    download(toCSV(shown), `hisaab-${range.from}-to-${range.to}.csv`)
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

      {/* The way into selection, and the count once you are in it. A button
          rather than a long-press: a gesture nothing on screen mentions is a
          feature only the person who built it knows about, and it has no
          keyboard equivalent. */}
      {loaded && shown.length > 0 && (
        <div className="listbar">
          {selecting ? (
            <>
              <span className="muted">
                {chosen.length} of {shown.length} selected
              </span>
              <span>
                <button className="linkish" onClick={toggleAll}>
                  {allChosen ? 'Select none' : 'Select all'}
                </button>
                <button className="linkish quiet" style={{ marginLeft: 14 }} onClick={leaveSelection}>
                  Done
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="muted">
                {shown.length} row{shown.length === 1 ? '' : 's'}
              </span>
              <button className="linkish" onClick={() => setSelecting(true)}>
                Select
              </button>
            </>
          )}
        </div>
      )}

      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

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
              <Row
                key={r.id}
                r={r}
                onChange={refresh}
                selectable={selecting}
                selected={picked.has(r.id)}
                onToggle={toggle}
              />
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

      {/* Docked, because the selection is made by scrolling and the actions
          have to stay reachable from wherever that ends. Padding below the list
          keeps the last row off the bar. */}
      {selecting && chosen.length > 0 && (
        <>
          <div style={{ height: 88 }} aria-hidden="true" />
          <div className="bulkbar">
            <button className="btn small" disabled={working} onClick={() => setEditing(true)}>
              Edit {chosen.length}
            </button>
            <button className="btn ghost small" disabled={working} onClick={() => setConfirming(true)}>
              Delete {chosen.length}
            </button>
          </div>
        </>
      )}

      {/* Mounted always, opened by the flag. A sheet unmounted the instant its
          action finishes never runs its own close, and the history entry it
          pushed to make the Back button work outlives it — one dead press of
          Back for every bulk delete. Same reason EditSheet holds itself open
          through the exit. */}
      <Sheet open={confirming} onClose={() => setConfirming(false)} title="Delete these rows">
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.7, margin: '0 0 6px' }}>
          {chosen.length} row{chosen.length === 1 ? '' : 's'} worth{' '}
          <span className="num">₹{money(chosen.reduce((s, r) => s + (Number(r.amount) || 0), 0))}</span>{' '}
          will be removed from the ledger. It can&rsquo;t be undone.
        </p>
        <div className="danger-actions" style={{ marginTop: 18 }}>
          <button className="btn ghost small" onClick={() => setConfirming(false)}>
            Leave them
          </button>
          <button
            className="btn small destructive"
            disabled={working}
            onClick={() => apply((ids) => deleteTransactions(ids))}
          >
            {working ? 'Deleting…' : `Delete ${chosen.length}`}
          </button>
        </div>
      </Sheet>

      <BulkSheet
        open={editing}
        count={chosen.length}
        busy={working}
        onClose={() => setEditing(false)}
        onApply={(patch) => apply((ids) => updateTransactions(ids, patch))}
      />
    </div>
  )
}

/**
 * One patch, many rows.
 *
 * Every field starts on "leave unchanged" and only what you set is sent — the
 * alternative is a form pre-filled from one of the selected rows, which quietly
 * writes that row's method onto the other thirty-nine.
 *
 * Setting a category also clears the review flag, the same as fixing one row
 * does in the ledger drawer: a category you chose by hand is not a guess the
 * app is unsure about. Nothing else clears it, because setting an account says
 * nothing about whether the category was right.
 */
function BulkSheet({ open, count, busy, onClose, onApply }) {
  const [d, setD] = useState({ category: '', type: '', direction: '', method: '', account: '' })
  const [accounts, setAccounts] = useState([])
  const [methods, setMethods] = useState([])

  useEffect(() => {
    if (!open) return
    setD({ category: '', type: '', direction: '', method: '', account: '' })
    listAccounts().then(setAccounts).catch(() => {})
    listMethods().then(setMethods).catch(() => {})
  }, [open])

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }))

  // Built in lib/entry.js, not here: the couplings it enforces — direction
  // follows type, a row that stops being a transfer loses its destination —
  // are the ones every other write path in the app already applies, and they
  // are worth a test of their own.
  const patch = bulkPatch(d)
  const touched = Object.keys(patch).length > 0

  const UNCHANGED = { value: '', label: 'Leave unchanged' }

  return (
    <Sheet open={open} onClose={onClose} title={`Edit ${count} row${count === 1 ? '' : 's'}`}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.7, margin: '0 0 16px' }}>
        Whatever you set here replaces that field on all {count}. Anything left alone stays as it is.
      </p>

      {/* Every other control here has a "Leave unchanged" row in its own sheet.
          The category picker has no such entry — it is the same component the
          add form uses, where an empty choice is not a thing you can make — so a
          category tapped by mistake could not be taken back without closing the
          sheet and starting again. The undo goes beside it rather than into the
          picker, which eight other screens share. */}
      <div className="field">
        <span>
          Category
          {d.category && (
            <button
              type="button"
              className="linkish quiet"
              style={{ marginLeft: 10, fontSize: 12 }}
              onClick={() => set('category', '')}
            >
              Leave unchanged
            </button>
          )}
        </span>
        <CategoryPicker
          compact
          value={d.category}
          placeholder="Leave unchanged"
          onChange={(c) => set('category', c)}
        />
      </div>

      <div className="pair">
        <Select
          label="Type"
          value={d.type}
          placeholder="Leave unchanged"
          options={[UNCHANGED, ...TYPE_OPTIONS]}
          onChange={(v) => set('type', v)}
        />
        <Select
          label="Direction"
          value={d.direction}
          placeholder="Leave unchanged"
          options={[UNCHANGED, ...DIRECTIONS]}
          onChange={(v) => set('direction', v)}
        />
      </div>

      <div className="pair">
        <Select
          label="Paid with"
          value={d.method}
          placeholder="Leave unchanged"
          options={[UNCHANGED, ...methods]}
          onChange={(v) => set('method', v)}
          allowNew
          newLabel="New method"
        />
        <Select
          label="Account"
          value={d.account}
          placeholder="Leave unchanged"
          options={[UNCHANGED, ...accounts]}
          onChange={(v) => set('account', v)}
          allowNew
          newLabel="New account"
        />
      </div>

      <button className="btn" disabled={busy || !touched} onClick={() => onApply(patch)}>
        {busy ? 'Saving…' : touched ? `Apply to ${count} row${count === 1 ? '' : 's'}` : 'Nothing set yet'}
      </button>
    </Sheet>
  )
}
