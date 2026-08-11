import { useState } from 'react'
import { saveTransactions } from '../lib/db'
import { learn } from '../lib/categorise'
import { CATEGORIES } from '../lib/categories'
import { today } from '../lib/format'

// The only place manual typing is acceptable: cash, which leaves no screenshot.
// Four fields, no wizard. If this ever grows a fifth, question it.

export default function ManualEntry({ onSaved }) {
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [category, setCategory] = useState('')
  const [date, setDate] = useState(today())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await saveTransactions([
        {
          amount: Number(amount),
          txn_date: date,
          direction: 'debit',
          type: category === 'Transfers' ? 'transfer' : 'expense',
          payee_raw: payee.trim(),
          payee_clean: payee.trim(),
          category: category || 'Other',
          method: 'cash',
          source: 'manual',
          confidence: 1.0,
          needs_review: false,
        },
      ])
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
      <label className="field">
        <span>Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">— pick —</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Date</span>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
      </label>
      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}
      <button className="btn" disabled={busy || !amount || !payee}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
