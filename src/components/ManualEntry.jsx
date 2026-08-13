import { useEffect, useState } from 'react'
import { saveTransactions, listAccounts, listMethods } from '../lib/db'
import { learn } from '../lib/categorise'
import { today } from '../lib/format'
import { TYPE_OPTIONS, DIRECTIONS, COUNTED } from '../lib/categories'
import {
  NATURAL_DIRECTION, blankEntry, readEntryDefaults, writeEntryDefaults,
} from '../lib/entry'
import CategoryPicker from './CategoryPicker.jsx'
import DateField from './DateField.jsx'
import Select from './Select.jsx'
import Sheet, { EXIT } from './Sheet.jsx'

// Typing in a payment. Any payment.
//
// This was "Add a cash payment" and only that: method was hardcoded to cash,
// direction to debit, there was no account field, and the type was inferred
// from whether you had picked the Transfers category. Which meant a card
// payment, a NEFT, a refund, an SIP or money a friend paid back could not be
// entered at all — the only route was to log a fake cash row and then go and
// edit it. A tracker that can only record what it can read off a screenshot is
// not recording your money.
//
// Four fields are always visible, because four fields is what a chai costs. The
// other six are behind a fold that remembers whether you had it open, and the
// two that repeat between payments — the rail and the pocket — come back filled
// in. See lib/entry.js.
//
// Owns its own sheet, the same as EditSheet. Inline it pushed today's ledger a
// screen and a half down the moment it opened, and on a phone the amount field
// landed under the keyboard with no context above it.

// The rails the parser knows, same list EditSheet offers. Whatever this ledger
// has actually used is added to it, plus anything you name yourself.
const METHODS = ['gpay', 'phonepe', 'paytm', 'card', 'cash', 'netbanking', 'UPI', 'NEFT', 'IMPS']

const FOLD_KEY = 'hisaab.entry.fold'

export default function ManualEntry({ open, onClose, onSaved, seed = null, title = 'Add a payment' }) {
  // Seeded once, on mount. Every caller mounts this only while it is open, so
  // there is no second seed to react to — and a useEffect that re-seeded would
  // throw away what someone had started typing.
  const [d, setD] = useState(() => {
    const base = seed ?? { ...blankEntry(), ...readEntryDefaults() }
    return { ...blankEntry(), ...base }
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [dup, setDup] = useState(false)
  // Open if it was open last time. Someone who pays by card logs every payment
  // through these fields; someone who pays cash never opens it once.
  const [more, setMore] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === '1' || Boolean(seed?.account || seed?.to_account)
    } catch {
      return false
    }
  })
  // Left alone, "Transfers" as a category used to be what made a row a
  // transfer. There is a real type control now, but it is behind the fold — so
  // picking that category still sets the type, right up until someone sets the
  // type themselves and means it.
  const [typeTouched, setTypeTouched] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [methods, setMethods] = useState([])
  // Today mounts this only while the sheet is open, so telling it we closed
  // pulls the sheet out of the tree before it can animate down. Same flag
  // EditSheet carries for the same reason: drop it, let the exit run, then say.
  const [showing, setShowing] = useState(open)

  useEffect(() => {
    listAccounts().then(setAccounts).catch(() => {})
    listMethods().then(setMethods).catch(() => {})
  }, [])

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }))

  function setType(type) {
    setTypeTouched(true)
    // The direction follows the type unless it has been set by hand — a refund
    // typed as money out is the single easiest mistake to make in this form,
    // and it is wrong in both directions at once on every total.
    setD((p) => ({ ...p, type, direction: NATURAL_DIRECTION[type] ?? p.direction }))
  }

  function setCategory(category) {
    setD((p) => {
      const transfer = !typeTouched && category === 'Transfers'
      return {
        ...p,
        category,
        ...(transfer ? { type: 'transfer', direction: 'debit' } : {}),
      }
    })
  }

  function toggleMore() {
    setMore((m) => {
      try {
        localStorage.setItem(FOLD_KEY, m ? '0' : '1')
      } catch {
        // Storage blocked. The fold still works for this session.
      }
      return !m
    })
  }

  const finish = (then) => {
    setShowing(false)
    setTimeout(then, EXIT)
  }

  async function submit(e, force) {
    e.preventDefault()
    const amount = Number(d.amount)
    if (!(amount > 0)) return setErr('An amount is needed.')
    if (!d.payee.trim()) return setErr('Who it was paid to is needed.')
    if (!d.txn_date) return setErr('A date is needed.')

    setBusy(true)
    setErr(null)
    setDup(false)
    try {
      const payee = d.payee.trim()
      const { saved, duplicates } = await saveTransactions([
        {
          amount,
          txn_date: d.txn_date,
          // "Save anyway" is an instruction, so it is given a reference of its
          // own and can never be refused. It used to lean on the clock stamp,
          // which the Time field in the fold overrides — so a second ₹20 chai
          // typed with the same time rebuilt the identical synthRef, was
          // deduped again, and the prompt reappeared with no way through it.
          ...(force ? { txn_ref: `manual-${crypto.randomUUID()}` } : {}),
          // Otherwise: whatever was typed, and nothing if nothing was. A time
          // on every manual row would defeat the dedup that catches a
          // double-tap on Save.
          txn_time: d.txn_time || null,
          direction: d.direction,
          type: d.type,
          payee_raw: payee,
          payee_clean: payee,
          category: d.category || 'Other',
          // Not recorded is a real answer and stays null, rather than every
          // typed row claiming to be cash the way this form used to.
          method: d.method || null,
          account: d.account || null,
          to_account: d.type === 'transfer' ? d.to_account || null : null,
          note: d.note.trim() || null,
          source: 'manual',
          confidence: 1.0,
          needs_review: false,
        },
      ])
      // Nothing stored, and dedup is why. Closing the form as if it worked is
      // how a real second chai disappears — ask instead of assuming.
      if (!saved && duplicates) return setDup(true)

      writeEntryDefaults({ method: d.method, account: d.account })
      if (d.category) await learn(payee, { category: d.category, payee_clean: payee })
      finish(() => onSaved?.())
    } catch (e2) {
      setErr(e2.message ?? String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={showing} onClose={() => finish(onClose)} title={title}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Amount</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            required
            autoFocus
            className="num"
            value={d.amount}
            onChange={(e) => set('amount', e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="field">
          <span>{d.direction === 'credit' ? 'From' : 'Paid to'}</span>
          <input
            type="text"
            required
            maxLength={120}
            value={d.payee}
            onChange={(e) => set('payee', e.target.value)}
            placeholder="Auto, chai, sabzi…"
          />
        </label>

        <CategoryPicker value={d.category} onChange={setCategory} />

        <DateField value={d.txn_date} max={today()} onChange={(v) => set('txn_date', v)} />

        <button type="button" className="foldtoggle" aria-expanded={more} onClick={toggleMore}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
          More details
          {!more && (d.method || d.account) && (
            <span className="muted">{[d.method, d.account].filter(Boolean).join(' · ')}</span>
          )}
        </button>

        {/* Kept mounted, `inert` when shut: the same contract the ledger rows
            use. A collapsed subtree that is still a tab stop is worse than one
            that is not there at all. */}
        <div className="reveal" data-open={more} inert={!more}>
          <div className="foldbody">
            <div className="pair">
              <Select label="Type" value={d.type} options={TYPE_OPTIONS} onChange={setType} />
              <Select
                label="Direction"
                value={d.direction}
                options={DIRECTIONS}
                onChange={(v) => set('direction', v)}
              />
            </div>

            {!COUNTED.has(d.type) && (
              <p className="warn" style={{ fontSize: 12.5, margin: '-10px 0 16px' }}>
                A {d.type} is your own money moving — this row will be in no total on any screen.
              </p>
            )}

            <div className="pair">
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
              <label className="field">
                <span>Time</span>
                <input
                  type="time"
                  value={d.txn_time}
                  onChange={(e) => set('txn_time', e.target.value)}
                />
              </label>
            </div>

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
                maxLength={140}
                value={d.note}
                onChange={(e) => set('note', e.target.value)}
                placeholder="What it was for"
              />
            </label>
          </div>
        </div>

        {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

        {dup && (
          <div className="confirmnote">
            <p className="muted">
              Looks like ₹{d.amount} to {d.payee.trim()} is already logged for that day. Log it again?
            </p>
            <div className="danger-actions">
              <button type="button" className="btn ghost small" onClick={() => setDup(false)}>
                Leave it
              </button>
              <button type="button" className="btn small" disabled={busy} onClick={(e) => submit(e, true)}>
                Save anyway
              </button>
            </div>
          </div>
        )}

        <button className="btn" disabled={busy || !d.amount || !d.payee.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Sheet>
  )
}
