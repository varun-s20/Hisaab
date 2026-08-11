import { useEffect, useRef, useState } from 'react'
import { readBatch, preload } from '../lib/ocr'
import { parseScreenshot } from '../lib/parse'
import { categoriseBatch, persistAILearnings, learn } from '../lib/categorise'
import { saveTransactions, listTransactions, updateTransaction } from '../lib/db'
import { money, today, dayLabel, timeLabel, spendTotal } from '../lib/format'
import { colorFor, CATEGORIES } from '../lib/categories'
import ManualEntry from '../components/ManualEntry.jsx'

// The Phase 1 screen. One button, one number, one line of summary.
// Everything after the tap is automatic — the app only speaks when it's
// genuinely unsure. BUILD_GUIDE.md §6.6.

export default function Today({ onChange, reviewCount, goReview }) {
  const fileRef = useRef(null)
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(null) // { done, total, stage }
  const [result, setResult] = useState(null)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    listTransactions({ from: today(), to: today() }).then(setRows).catch(() => {})
    // Warm Tesseract while the user is reading the screen, not after they tap.
    const id = setTimeout(preload, 400)
    return () => clearTimeout(id)
  }, [])

  async function refresh() {
    const r = await listTransactions({ from: today(), to: today() })
    setRows(r)
    onChange?.()
  }

  async function handleFiles(e) {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // let the same files be picked again
    if (files.length === 0) return

    setResult(null)
    setBusy({ done: 0, total: files.length, stage: 'reading' })
    try {
      const texts = await readBatch(files, (done, total) =>
        setBusy({ done, total, stage: 'reading' }),
      )
      setBusy({ done: files.length, total: files.length, stage: 'sorting' })

      // One history screenshot carries ~7 transactions, a receipt carries one.
      const parsed = texts.flatMap((t) => parseScreenshot(t.text))
      const unreadable = parsed.filter((p) => !p.amount || !p.txn_date).length

      const categorised = await categoriseBatch(parsed)
      const { saved, duplicates } = await saveTransactions(categorised)
      persistAILearnings(categorised).catch(() => {}) // never block on this

      setResult({ saved, duplicates, unreadable })
      await refresh()
    } catch (err) {
      setResult({ error: err.message ?? String(err) })
    } finally {
      setBusy(null)
    }
  }

  const total = spendTotal(rows)

  return (
    <div className="screen">
      <div className="hero">
        <div className="amount num out">
          <span className="rupee">₹</span>
          {money(total)}
        </div>
        {/* "logged", not "spent" — ₹0 means nothing was entered, which is not
            the same claim as having spent nothing. */}
        <div className="label">logged today</div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden-file"
        onChange={handleFiles}
      />

      <button className="btn" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
        {busy
          ? busy.stage === 'reading'
            ? `Reading ${busy.done} of ${busy.total}…`
            : 'Sorting…'
          : 'Add screenshots'}
      </button>

      {busy && (
        <div className="progress" style={{ marginTop: 10 }}>
          <i style={{ width: `${(busy.done / busy.total) * 100}%` }} />
        </div>
      )}

      <p style={{ textAlign: 'center', marginTop: 14, fontSize: 14 }}>
        <button className="linkish" onClick={() => setManual((m) => !m)}>
          {manual ? 'Close' : 'Add cash payment'}
        </button>
      </p>

      {manual && (
        <ManualEntry
          onSaved={async () => {
            setManual(false)
            await refresh()
          }}
        />
      )}

      {result && <Summary result={result} reviewCount={reviewCount} goReview={goReview} />}

      {!result && reviewCount > 0 && (
        <p style={{ textAlign: 'center', marginTop: 8 }}>
          <button className="linkish alert" onClick={goReview}>
            {reviewCount} need{reviewCount === 1 ? 's' : ''} a look
          </button>
        </p>
      )}

      <h2 className="section">{dayLabel(today())}</h2>
      {rows.length === 0 ? (
        <p className="empty">Nothing logged today.</p>
      ) : (
        <ul className="ledger">
          {rows.map((r) => (
            <Row key={r.id} r={r} onChange={refresh} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Summary({ result, reviewCount, goReview }) {
  if (result.error) {
    return (
      <p className="alert" style={{ fontSize: 14, marginTop: 14 }}>
        Couldn't save: {result.error}
      </p>
    )
  }
  const bits = [`${result.saved} saved`]
  if (result.duplicates) bits.push(`${result.duplicates} already logged`)
  if (result.unreadable) bits.push(`${result.unreadable} unreadable`)
  return (
    <p style={{ textAlign: 'center', marginTop: 14, fontSize: 14 }} className="muted">
      {bits.join(' · ')}
      {reviewCount > 0 && (
        <>
          {' · '}
          <button className="linkish alert" onClick={goReview}>
            {reviewCount} need{reviewCount === 1 ? 's' : ''} a look
          </button>
        </>
      )}
    </p>
  )
}

// Tap a row to fix its category on the spot. One tap, one select, no modal.
export function Row({ r, onChange, showDate = false }) {
  const [open, setOpen] = useState(false)
  const credit = r.direction === 'credit'
  const meta = [
    showDate ? dayLabel(r.txn_date) : timeLabel(r.txn_time),
    r.category,
    r.type !== 'expense' ? r.type : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li>
      <button className={`row ${r.needs_review ? 'flagged' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="dot" style={{ background: colorFor(r.category) }} />
        <span className="who">
          <span className="name">{r.payee_clean || r.payee_raw}</span>
          <span className="meta">{meta}</span>
        </span>
        <span className={`amt num ${credit ? 'in' : 'out'}`}>
          {credit ? '+' : ''}
          <span className="rupee">₹</span>
          {money(r.amount)}
        </span>
      </button>
      {open && <QuickEdit r={r} onDone={() => { setOpen(false); onChange?.() }} />}
    </li>
  )
}

function QuickEdit({ r, onDone }) {
  const [saving, setSaving] = useState(false)

  async function set(patch, learnIt) {
    setSaving(true)
    await updateTransaction(r.id, { ...patch, needs_review: false })
    if (learnIt) {
      await learn(r.payee_raw, { category: patch.category, payee_clean: r.payee_clean || r.payee_raw })
    }
    setSaving(false)
    onDone()
  }

  return (
    <div style={{ padding: '10px 0 16px' }}>
      <label className="field">
        <span>Category</span>
        <select
          disabled={saving}
          value={r.category ?? ''}
          onChange={(e) => set({ category: e.target.value }, true)}
        >
          <option value="">— pick —</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Type — transfers never count as spending</span>
        <select disabled={saving} value={r.type} onChange={(e) => set({ type: e.target.value })}>
          {['expense', 'income', 'transfer', 'refund', 'lent', 'repaid'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
    </div>
  )
}
