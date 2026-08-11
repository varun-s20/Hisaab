import { useState } from 'react'
import { supabase, configured } from '../lib/supabase'

// Magic link, with a 6-digit code fallback.
//
// The fallback is not optional: on Android, tapping a link inside Gmail often
// opens a different browser than the installed PWA, which loses the session
// entirely. Typing the code into the app that's already open always works.

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  if (!configured) {
    return (
      <div className="screen">
        <p className="eyebrow">Paisa</p>
        <h1 className="title">Not configured</h1>
        <p className="muted">
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> are missing.
          Copy <code>.env.local.example</code> to <code>.env.local</code>, fill both, restart the
          dev server. See <code>SETUP.md</code>.
        </p>
      </div>
    )
  }

  async function sendLink(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) setMsg(error.message)
    else setSent(true)
  }

  async function verifyCode(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    })
    setBusy(false)
    if (error) setMsg(error.message)
    // Success needs no handler — the auth listener in App swaps the screen.
  }

  return (
    <div className="screen">
      <div style={{ marginTop: '18vh' }}>
        <p className="eyebrow">Paisa</p>
        <h1 className="title">{sent ? 'Check your email' : 'Sign in'}</h1>

        {!sent && (
          <form onSubmit={sendLink}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button className="btn" disabled={busy || !email}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </form>
        )}

        {sent && (
          <form onSubmit={verifyCode}>
            <p className="muted" style={{ marginTop: 0 }}>
              Tap the link in the email, or type the code from it here.
            </p>
            <label className="field">
              <span>Code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="num"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                style={{ letterSpacing: '0.3em', fontSize: 20 }}
              />
            </label>
            <button className="btn" disabled={busy || code.length < 6}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <p style={{ marginTop: 16, textAlign: 'center' }}>
              <button type="button" className="linkish" onClick={() => setSent(false)}>
                Use a different email
              </button>
            </p>
          </form>
        )}

        {msg && <p className="alert" style={{ fontSize: 14 }}>{msg}</p>}
      </div>
    </div>
  )
}
