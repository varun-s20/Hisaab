import { useEffect, useState } from 'react'
import { updateTransaction, deleteTransaction, listAccounts, listMethods } from '../lib/db'
import { learn } from '../lib/categorise'
import { TYPE_OPTIONS, DIRECTIONS, COUNTED } from '../lib/categories'
import { today } from '../lib/format'
import CategoryPicker from './CategoryPicker.jsx'
import DateField from './DateField.jsx'
import Select from './Select.jsx'
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
  to_account: t.to_account ?? '',
  note: t.note ?? '',
})

export default function EditSheet({ row, open, onClose, onSaved, onDeleted }) {
  const [d, setD] = useState(() => draftOf(row))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  // What this ledger already uses. Both cached in db.js, so the queries only
  // actually run on the first edit of a session and after anything writes one.
  const [accounts, setAccounts] = useState([])
  const [methods, setMethods] = useState([])
  useEffect(() => {
    listAccounts().then(setAccounts).catch(() => {})
    listMethods().then(setMethods).catch(() => {})
  }, [])
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
        // Only a transfer has a destination. Cleared otherwise so a row that
        // stops being a transfer does not leave a balance crediting an
        // envelope that no longer receives anything.
        to_account: d.type === 'transfer' ? d.to_account || null : null,
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
          <Select
            label="Direction"
            value={d.direction}
            options={DIRECTIONS}
            onChange={(v) => set('direction', v)}
          />
        </div>

        <div className="pair">
          <DateField value={d.txn_date} max={today()} onChange={(v) => set('txn_date', v)} />
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
          <Select label="Type" value={d.type} options={TYPE_OPTIONS} onChange={(v) => set('type', v)} />
          {/* The rails the parser knows, plus whatever this ledger has
              actually used, plus anything you name yourself — three credit
              cards are three ways to pay and the built-in list only ever had
              one word for all of them. */}
          <Select
            label="Paid with"
            value={d.method}
            placeholder="Not recorded"
            options={[{ value: '', label: 'Not recorded' }, ...new Set([...METHODS, ...methods])]}
            onChange={(v) => set('method', v)}
            allowNew
            newLabel="New method"
            newPlaceholder="Amex, HDFC Regalia, UPI Lite…"
          />
        </div>

        {!COUNTED.has(d.type) && (
          <p className="warn" style={{ fontSize: 12.5, margin: '-10px 0 16px' }}>
            A {d.type} is your own money moving — this row is in no total on any screen.
          </p>
        )}

        {/* Was a free-text input, and free text fragments: "HDFC card",
            "HDFC Card" and "hdfc" are three different accounts as far as every
            total is concerned, which made grouping by one worthless. The list
            is whatever this ledger already uses — see listAccounts. */}
        <Select
          label="Account — which card, bank or envelope"
          value={d.account}
          placeholder="Not recorded"
          hint="Whatever you actually think in: HDFC card, SBI, Cash, or envelopes like Needs and Wants."
          options={[{ value: '', label: 'Not recorded' }, ...accounts]}
          onChange={(v) => set('account', v)}
          allowNew
          newLabel="New account"
          newPlaceholder="HDFC card, SBI, Wants…"
        />

        {/* Only a transfer has one, and only a transfer should: this is the
            half that makes an envelope balance possible, because it is the
            only way a row says money *arrived* somewhere you own. */}
        {d.type === 'transfer' && (
          <Select
            label="Into — where it landed"
            value={d.to_account}
            placeholder="Not recorded"
            hint="A transfer leaves one pocket and enters another. Naming both is what lets Accounts tell you what is left in each."
            options={[{ value: '', label: 'Not recorded' }, ...accounts.filter((a) => a !== d.account)]}
            onChange={(v) => set('to_account', v)}
            allowNew
            newLabel="New account"
            newPlaceholder="Needs, Wants, Savings…"
          />
        )}

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
