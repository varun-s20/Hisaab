import { useEffect, useState } from 'react'
import { listNeedsReview, updateTransaction, deleteTransaction } from '../lib/db'
import { learn } from '../lib/categorise'
import { CATEGORIES, TYPES } from '../lib/categories'
import { money } from '../lib/format'

// What the parser handed us, shaped for inputs. Blank means it couldn't read it —
// never a blank form, only the blanks that are genuinely blank.
const draftOf = (t) => ({
  amount: t.amount ?? '',
  txn_date: t.txn_date ?? '',
  txn_time: (t.txn_time ?? '').slice(0, 5), // postgres time is HH:MM:SS, the input wants HH:MM
  payee_clean: t.payee_clean || t.payee_raw || '',
  category: t.category ?? '',
  type: t.type ?? 'expense',
  direction: t.direction ?? 'debit',
})

export default function Review({ onChange }) {
  const [rows, setRows] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState('')

  const fail = (e) => setErr(e?.message || 'That didn’t go through.')

  useEffect(() => {
    let live = true
    listNeedsReview()
      .then((data) => {
        if (!live) return
        // Worst confidence first — the ones the parser was least sure about.
        const sorted = [...data].sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))
        setRows(sorted)
        setDrafts(Object.fromEntries(sorted.map((t) => [t.id, draftOf(t)])))
      })
      .catch((e) => {
        if (live) fail(e)
      })
    return () => {
      live = false
    }
  }, [])

  // One shot, no retry loop. The toast clears itself rather than sitting over the nav.
  useEffect(() => {
    if (!err) return
    const id = setTimeout(() => setErr(''), 4000)
    return () => clearTimeout(id)
  }, [err])

  const set = (id, k, v) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: v } }))

  const drop = (id) => {
    setRows((r) => r.filter((x) => x.id !== id))
    onChange?.()
  }

  async function save(t) {
    const d = drafts[t.id]
    if (!(Number(d.amount) > 0)) return setErr('An amount is needed.')
    if (!d.txn_date) return setErr('A date is needed.')

    setBusy(t.id)
    try {
      await updateTransaction(t.id, {
        amount: Number(d.amount),
        txn_date: d.txn_date,
        txn_time: d.txn_time || null,
        // payee_raw is the key the merchant map matches on — keep it unless there wasn't one.
        payee_raw: t.payee_raw || d.payee_clean,
        payee_clean: d.payee_clean || null,
        category: d.category || null,
        type: d.type,
        direction: d.direction,
        needs_review: false,
        confidence: 1.0,
      })
      drop(t.id)

      // A category the user picked outranks every guess. Remember it (§7.4).
      const key = t.payee_raw || d.payee_clean
      if (d.category && d.category !== t.category && key) {
        learn(key, { category: d.category, payee_clean: d.payee_clean, source: 'user' }).catch(fail)
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // ponytail: optimistic, no confirm dialog. Single-user app, one row, undo is re-uploading.
  async function discard(id) {
    drop(id)
    try {
      await deleteTransaction(id)
    } catch (e) {
      fail(e)
    }
  }

  const n = rows?.length ?? 0

  return (
    <div className="screen">
      {rows && n === 0 && <p className="empty">Nothing needs a look.</p>}

      {n > 0 && (
        <h1 className="title">
          {n} need{n === 1 ? 's' : ''} a look
        </h1>
      )}

      {rows?.map((t) => {
        const d = drafts[t.id]
        if (!d) return null
        return (
          <div className="panel" key={t.id}>
            <div className="stat" style={{ marginBottom: 16 }}>
              <span className="k">{t.payee_raw || 'No payee read.'}</span>
              <span className="v">
                {t.amount == null ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Couldn&rsquo;t read the amount.
                  </span>
                ) : (
                  <span className={`num ${t.direction === 'credit' ? 'in' : 'out'}`}>
                    <span className="rupee">₹</span>
                    {money(t.amount)}
                  </span>
                )}
              </span>
            </div>

            <label className="field">
              <span>Amount</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={d.amount}
                onChange={(e) => set(t.id, 'amount', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Date</span>
              <input
                type="date"
                value={d.txn_date}
                onChange={(e) => set(t.id, 'txn_date', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Time (optional)</span>
              <input
                type="time"
                value={d.txn_time}
                onChange={(e) => set(t.id, 'txn_time', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Payee</span>
              <input
                type="text"
                value={d.payee_clean}
                onChange={(e) => set(t.id, 'payee_clean', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Category</span>
              <select value={d.category} onChange={(e) => set(t.id, 'category', e.target.value)}>
                <option value="">Pick one</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Type</span>
              <select value={d.type} onChange={(e) => set(t.id, 'type', e.target.value)}>
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {ty}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Direction</span>
              <select value={d.direction} onChange={(e) => set(t.id, 'direction', e.target.value)}>
                <option value="debit">Money out</option>
                <option value="credit">Money in</option>
              </select>
            </label>

            <details style={{ marginBottom: 16 }}>
              <summary className="linkish" style={{ cursor: 'pointer' }}>
                What the app read
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  color: 'var(--muted)',
                  margin: '10px 0 0',
                }}
              >
                {t.raw_text || 'No text captured.'}
              </pre>
            </details>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <button className="btn small" onClick={() => save(t)} disabled={busy === t.id}>
                {busy === t.id ? 'Saving' : 'Save'}
              </button>
              <button className="linkish" onClick={() => discard(t.id)}>
                Discard
              </button>
            </div>
          </div>
        )
      })}

      {err && <div className="toast">{err}</div>}
    </div>
  )
}
