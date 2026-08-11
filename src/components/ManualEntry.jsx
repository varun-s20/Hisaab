import { useState } from 'react'
import { saveTransactions } from '../lib/db'
import { learn } from '../lib/categorise'
import { today } from '../lib/format'
import CategoryPicker from './CategoryPicker.jsx'

// The only place manual typing is acceptable: cash, which leaves no screenshot.
// Four fields, no wizard. If this ever grows a fifth, question it.

// A manual row carries no time, so synthRef keys it on date+amount+payee alone
// and a second ₹20 chai today is indistinguishable from a re-upload of the
// first. Sending the clock is what makes the forced one its own row.
// Seconds included: synthRef keeps them when they are there, so two forced
// saves inside the same minute are still two rows.
const clockTime = () => new Date().toTimeString().slice(0, 8)

export default function ManualEntry({ onSaved }) {
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [category, setCategory] = useState('')
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [dup, setDup] = useState(false)

  async function submit(e, force) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    setDup(false)
    try {
      const { saved, duplicates } = await saveTransactions([
        {
          amount: Number(amount),
          txn_date: date,
          // Only when forced — a time on every manual row would defeat the
          // dedup that catches an honest double-tap on Save.
          txn_time: force ? clockTime() : null,
          direction: 'debit',
          type: category === 'Transfers' ? 'transfer' : 'expense',
          payee_raw: payee.trim(),
          payee_clean: payee.trim(),
          category: category || 'Other',
          method: 'cash',
          note: note.trim() || null,
          source: 'manual',
          confidence: 1.0,
          needs_review: false,
        },
      ])
      // Nothing stored, and dedup is why. Closing the form as if it worked is
      // how a real second chai disappears — ask instead of assuming.
      if (!saved && duplicates) return setDup(true)
      if (category) await learn(payee.trim(), { category, payee_clean: payee.trim() })
      onSaved?.()
    } catch (e2) {
      setErr(e2.message ?? String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="panel" style={{ marginTop: 14 }}>
      <label className="field">
        <span>Amount</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          required
          className="num"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
        />
      </label>
      <label className="field">
        <span>Paid to</span>
        <input
          type="text"
          required
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          placeholder="Auto, chai, sabzi…"
        />
      </label>
      <CategoryPicker value={category} onChange={setCategory} />
      <label className="field">
        <span>Date</span>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <input
          type="text"
          maxLength={140}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What it was for"
        />
      </label>
      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}
      {dup && (
        <div className="confirmnote">
          <p className="muted">
            Looks like ₹{amount} to {payee.trim()} is already logged for that day. Log it again?
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
      <button className="btn" disabled={busy || !amount || !payee}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
