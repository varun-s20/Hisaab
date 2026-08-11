import { useState } from 'react'
import { updateTransaction, deleteTransaction } from '../lib/db'
import { learn } from '../lib/categorise'
import { TYPES } from '../lib/categories'
import { today } from '../lib/format'
import CategoryPicker from './CategoryPicker.jsx'
import Sheet, { EXIT } from './Sheet.jsx'

// Everything about a row, in one place. Before this the only editable fields
// were category and type, and only on rows the parser had already flagged —
// so a misread amount was unfixable unless you happened to catch it in Review.

const METHODS = ['gpay', 'phonepe', 'paytm', 'card', 'cash', 'netbanking', 'UPI', 'NEFT', 'IMPS']

const draftOf = (t) => ({
  amount: t.amount ?? '',
  txn_date: t.txn_date ?? today(),
  txn_time: (t.txn_time ?? '').slice(0, 5), // postgres time is HH:MM:SS, the input wants HH:MM
  payee_clean: t.payee_clean || t.payee_raw || '',
  category: t.category ?? '',
  type: t.type ?? 'expense',
  direction: t.direction ?? 'debit',
  method: t.method ?? '',
  account: t.account ?? '',
  note: t.note ?? '',
})

export default function EditSheet({ row, open, onClose, onSaved, onDeleted }) {
  const [d, setD] = useState(() => draftOf(row))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  // The screens mount this component only while a row is being edited, so
  // telling them it closed pulls the sheet out of the tree before it can
  // animate. The flag lives here instead: drop it, let Sheet run its exit,
  // then tell them. `open` seeds it because that is all a caller can say.
  const [showing, setShowing] = useState(open)

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }))

  // Both sides come out of draftOf, same keys in the same order, so this is a
  // cheap compare. A retyped identical amount reads as changed ('20' against
  // 20) — that errs towards asking, which is the safe side of the question.
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(row))

  function finish() {
    setShowing(false)
    setTimeout(onClose, EXIT)
  }

  // Every way out lands here — the X, the scrim, Escape, hardware Back.
  function requestClose() {
    if (dirty && !discarding) return setDiscarding(true)
    finish()
  }

  async function save(e) {
    e.preventDefault()
    if (!(Number(d.amount) > 0)) return setErr('An amount is needed.')
    if (!d.txn_date) return setErr('A date is needed.')

    setBusy(true)
    setErr('')
    try {
      await updateTransaction(row.id, {
        amount: Number(d.amount),
        txn_date: d.txn_date,
        txn_time: d.txn_time || null,
        // payee_raw is the key the merchant map matches on — never rewrite it
        // from an edit, or the mapping silently stops applying.
        payee_clean: d.payee_clean || null,
        category: d.category || null,
        type: d.type,
        direction: d.direction,
        method: d.method || null,
        account: d.account || null,
        note: d.note || null,
        needs_review: false,
      })
      // A category you picked by hand outranks every guess — remember it.
      if (d.category && d.category !== row.category && row.payee_raw) {
        learn(row.payee_raw, { category: d.category, payee_clean: d.payee_clean, source: 'user' }).catch(() => {})
      }
      onSaved?.()
      finish()
    } catch (e2) {
      setErr(e2.message ?? String(e2))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteTransaction(row.id)
      onDeleted?.()
      finish()
    } catch (e2) {
      setErr(e2.message ?? String(e2))
      setBusy(false)
    }
  }

  return (
    <Sheet open={showing} onClose={requestClose} title="Edit transaction">
      <form onSubmit={save}>
        {/* Closing on a half-typed amount used to throw it away without a
            word. Same two steps as the delete below, and the same reason. */}
        {discarding && (
          <div className="confirmnote">
            <p className="muted">Your changes haven’t been saved. Discard them?</p>
            <div className="danger-actions">
              <button
                type="button"
                className="btn ghost small"
                autoFocus
                onClick={() => setDiscarding(false)}
              >
                Keep editing
              </button>
              <button type="button" className="btn small destructive" onClick={finish}>
                Discard
              </button>
            </div>
          </div>
        )}

        <div className="pair">
          <label className="field">
            <span>Amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              className="num"
              value={d.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Direction</span>
            <select value={d.direction} onChange={(e) => set('direction', e.target.value)}>
              <option value="debit">Money out</option>
              <option value="credit">Money in</option>
            </select>
          </label>
        </div>

        <div className="pair">
          <label className="field">
            <span>Date</span>
            <input type="date" value={d.txn_date} onChange={(e) => set('txn_date', e.target.value)} />
          </label>
          <label className="field">
            <span>Time</span>
            <input type="time" value={d.txn_time} onChange={(e) => set('txn_time', e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Paid to</span>
          <input type="text" value={d.payee_clean} onChange={(e) => set('payee_clean', e.target.value)} />
        </label>

        <CategoryPicker value={d.category} onChange={(c) => set('category', c)} />

        <div className="pair">
          <label className="field">
            <span>Type</span>
            <select value={d.type} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Paid with</span>
            <select value={d.method} onChange={(e) => set('method', e.target.value)}>
              <option value="">Not recorded</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>Account — which card or bank, if it matters</span>
          <input
            type="text"
            value={d.account}
            maxLength={40}
            placeholder="HDFC card, SBI…"
            onChange={(e) => set('account', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Note</span>
          <input
            type="text"
            value={d.note}
            maxLength={140}
            placeholder="Dinner with Aman, my share…"
            onChange={(e) => set('note', e.target.value)}
          />
        </label>

        {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>

        {/* Two steps, inline. A window.confirm() would freeze the whole page,
            and deleting a row is not recoverable from anywhere in this app. */}
        <div className="danger">
          {confirming ? (
            <>
              <p className="muted">Delete this transaction? It can’t be undone.</p>
              <div className="danger-actions">
                <button type="button" className="btn ghost small" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
                <button type="button" className="btn small destructive" disabled={busy} onClick={remove}>
                  Delete
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="linkish danger-link" onClick={() => setConfirming(true)}>
              Delete this transaction
            </button>
          )}
        </div>
      </form>
    </Sheet>
  )
}
