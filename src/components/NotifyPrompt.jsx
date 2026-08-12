import { useEffect, useState } from 'react'
import * as notify from '../lib/notify'

// Asked once, on the home screen, on a button that says what it is for.
// Reminders are on by default; this is only the browser permission they cannot
// work without. Either answer retires the card for good — the switch under
// More → Reminders is the way back.

export default function NotifyPrompt() {
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    notify.shouldAsk().then(setShow)
  }, [])

  if (!show) return null

  async function turnOn() {
    setErr('')
    try {
      await notify.markAsked()
      await notify.enable()
      setShow(false)
    } catch (e) {
      setErr(e.message ?? String(e))
    }
  }

  async function notNow() {
    await notify.markAsked()
    setShow(false)
  }

  return (
    <div className="found">
      <div className="head">
        <div className="title">Reminders are on</div>
        <p className="sub">
          The 1st to set a budget, each evening to log the day, Sunday if anything is
          waiting. Written and scheduled on this device — nothing about your money is sent
          anywhere. Your browser still has to allow them.
        </p>
      </div>
      {err && (
        <p className="alert" style={{ fontSize: 13, padding: '0 16px', margin: '0 0 10px' }}>
          {err}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, padding: '0 16px 16px' }}>
        <button type="button" className="btn small" onClick={turnOn}>
          Allow
        </button>
        <button type="button" className="btn ghost small" onClick={notNow}>
          Not now
        </button>
      </div>
    </div>
  )
}
