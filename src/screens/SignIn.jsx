import { useState } from 'react'
import { configured, sendCode as requestCode, verifyCode as checkCode } from '../lib/auth'
import InstallButton from '../components/InstallButton.jsx'

// The app icon itself, not a second copy of the artwork — it is already
// precached, so the sign-in screen paints instantly and offline. Sits on the
// cream page rather than inside the green panel below, because the logo brings
// its own field and two greens meeting at an edge reads as a mistake.
const Logo = ({ size = 76 }) => (
  <img
    src="/icon-192.png"
    alt="Hisaab, by Broombuilds"
    width={size}
    height={size}
    style={{ display: 'block', borderRadius: size * 0.24, marginBottom: 20 }}
  />
)

// A 6-digit code, and nothing else.
//
// The link was never the right primary: on Android, tapping one inside Gmail
// opens whichever browser Gmail feels like, not the installed PWA, so the
// session lands in a window the user isn't looking at. Typing the code into the
// app that is already open in front of them always works.
//
// Whether the email carries a link, a code, or both is decided by the Supabase
// email template, not by this file — supabase/email/*.html use {{ .Token }}
// alone, which is what makes the sent mail code-only. See SETUP.md §Auth.
//
// Sign-up is by approval. Anyone may ask; only the admin creates the account.

/**
 * Supabase's answer when the address has no account and this app is not allowed
 * to make one. Two shapes, because there are two locks and either can be the
 * one that fires: `otp_disabled` is `shouldCreateUser: false` below,
 * `signup_disabled` is the project-wide toggle (SETUP.md §3a).
 *
 * The message is matched as well as the code because the code field was added
 * to gotrue after both messages existed, and an older project sends only one.
 */
const unknownAddress = (error) =>
  error?.code === 'otp_disabled' ||
  error?.code === 'signup_disabled' ||
  /signups? not allowed/i.test(error?.message ?? '')

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [note, setNote] = useState(null) // a good-news line, kept apart from msg

  if (!configured) {
    return (
      <div className="screen">
        <Logo size={56} />
        <h1 className="title">Not configured</h1>
        <p className="muted">
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> are missing.
          Copy <code>.env.local.example</code> to <code>.env.local</code>, fill both, restart the
          dev server. See <code>SETUP.md</code>.
        </p>
      </div>
    )
  }

  /**
   * Record the request and say so.
   *
   * This used to be a direct insert with the anon key, which meant the one
   * publicly writable table in the schema. It now goes through the Worker
   * (worker/access.js), which writes it with the service role, caps how much
   * mail it can cause, and emails the admin two signed Approve / Reject links.
   *
   * The line below is the same however the ask lands — new, already pending,
   * rejected last week, or the endpoint being down. A stranger learns only that
   * the door is closed, and anyone may knock again.
   */
  async function askForAccess(address) {
    try {
      await fetch('/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address }),
      })
    } catch {
      // Offline, or the Worker is down. Telling them to try again later is no
      // more useful than the waiting-list line they are about to read.
    }
    setNote(
      'Hisaab is invite-only. You’re on the waiting list — you’ll usually hear back within 24–72 hours.',
    )
  }

  // No emailRedirectTo: there is no link to come back through. Passing one only
  // tells Supabase where a link it isn't sending would have pointed.
  async function sendCode(e, again) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    setNote(null)
    // Lower-cased so the request row and the account the admin creates from it
    // are the same string. Supabase treats the address case-insensitively; the
    // unique index on access_requests.email does not.
    const address = email.trim().toLowerCase()
    const { error } = await requestCode(address, {
      // Sign-up is by approval, not self-service. Without this, anyone with an
      // email address gets an account — and with it a token that passes
      // api/_auth.js and spends the owner's Gemini quota on every call.
      options: { shouldCreateUser: false },
    })
    setBusy(false)
    if (error) {
      // "Signups not allowed" is not an error the person can act on, and the
      // raw wording reads as a broken app rather than a closed door.
      if (unknownAddress(error)) return askForAccess(address)
      return setMsg(error.message)
    }
    setSent(true)
    // Resending is silent otherwise — the screen already says "check your
    // email", so nothing on it changes and the tap reads as having missed.
    if (again) {
      setCode('')
      setNote('Sent again. The older code stopped working.')
    }
  }

  async function verifyCode(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    setNote(null) // "sent again" has been overtaken by whatever happens next
    // 'email' covers both templates — a first-time address gets Confirm signup,
    // a returning one gets Magic Link, and the code verifies the same.
    const { error } = await checkCode(email.trim(), code.trim())
    setBusy(false)
    // Expired and mistyped are the same 403 from the API, and its wording
    // ("Token has expired or is invalid") makes a typo sound unrecoverable.
    if (error) setMsg(/expired|invalid/i.test(error.message) ? 'That code didn’t work. Check it, or send a new one.' : error.message)
    // Success needs no handler — the auth listener in App swaps the screen.
  }

  return (
    <div className="screen">
      <div style={{ marginTop: '9vh' }}>
        <Logo />
        <div className="brand" style={{ marginBottom: 28 }}>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 'clamp(26px, 8.4vw, 34px)',
              fontWeight: 700,
              letterSpacing: '-0.035em',
              lineHeight: 1.08,
            }}
          >
            Your money,
            <br />
            understood.
          </div>
          <p className="caption" style={{ margin: '14px 0 0' }}>
            Drop a screenshot. The ledger writes itself.
          </p>
        </div>

        <h1 className="title">{sent ? 'Enter your code' : 'Sign in'}</h1>

        {!sent && (
          <form onSubmit={sendCode}>
            <p className="muted" style={{ margin: '0 0 16px' }}>
              No password. We&rsquo;ll email you a six-digit code.
            </p>
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
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {sent && (
          <form onSubmit={verifyCode}>
            <p className="muted" style={{ marginTop: 0 }}>
              Sent to <b style={{ color: 'var(--text)' }}>{email.trim()}</b>. It expires in an hour.
            </p>
            <label className="field">
              <span>Six-digit code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                // Android's SMS/email autofill only offers the code when the
                // field is a real one-time-code field of the right length.
                pattern="[0-9]*"
                autoFocus
                className="num"
                maxLength={6}
                value={code}
                // Paste from a mail app brings the surrounding spaces with it.
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                style={{ letterSpacing: '0.3em', fontSize: 20 }}
              />
            </label>
            <button className="btn" disabled={busy || code.length < 6}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <p style={{ marginTop: 16, textAlign: 'center', display: 'flex', justifyContent: 'center', gap: 18 }}>
              <button type="button" className="linkish" disabled={busy} onClick={(e) => sendCode(e, true)}>
                Send a new code
              </button>
              <button type="button" className="linkish quiet" onClick={() => { setSent(false); setCode(''); setNote(null); setMsg(null) }}>
                Change email
              </button>
            </p>
          </form>
        )}

        {note && <p className="muted" style={{ fontSize: 14 }}>{note}</p>}
        {msg && <p className="alert" style={{ fontSize: 14 }}>{msg}</p>}

        {/* Below the fold of the form on purpose. Signing in is why they came;
            installing is the thing they'd otherwise have to find under Chrome's
            three dots. Renders nothing where it can't work — see the component. */}
        <div style={{ marginTop: 28 }}>
          <InstallButton />
        </div>
      </div>
    </div>
  )
}
