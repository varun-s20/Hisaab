import { useState } from 'react'
import { keyProblem, normaliseUrl, urlProblem } from '../lib/backend'
import { createBackend, probeByo } from '../lib/backends/index.js'
// No picture for step 3 on purpose: that step is two buttons in this app, not
// a control to find in a dashboard. Drop a screenshot of the SQL editor into
// ref/ and add it to scripts/redact-setup-shots.ps1 if it ever needs one.
import { ApiKeys, ConfirmEmail, NewProject, ProjectId } from '../components/SetupPanel.jsx'
import SETUP_SQL from '../../db/byo-setup.sql?raw'

// Setting up somebody else's Supabase project, one step at a time.
//
// The design decision worth knowing: every step that CAN be verified is, and a
// step will not tick until the check actually passes. Finding a button in the
// dashboard was never the hard part — the links below land on the exact page.
// The hard part is "I did it and something is still wrong", which is what a
// four-line list of instructions cannot help with and this can:
//
//   ran only half the SQL          caught by the table probe
//   copied the service_role key    caught before it is ever stored
//   saved the wrong toggle         caught when the account cannot be created
//   project paused since Tuesday   caught, and named as itself
//
// Each of those otherwise surfaces as a confusing failure three steps later,
// pointing at the wrong thing.

const DASHBOARD = 'https://supabase.com/dashboard'
const LINKS = {
  create: `${DASHBOARD}/new`,
  general: `${DASHBOARD}/project/_/settings/general`,
  keys: `${DASHBOARD}/project/_/settings/api-keys`,
  sql: `${DASHBOARD}/project/_/sql/new`,
  auth: `${DASHBOARD}/project/_/auth/providers`,
}

const STEPS = ['Create the project', 'Connect it', 'Create the tables', 'Let Hisaab in']

/** The step list, always visible, so the shape of the job is clear from step 1
 *  rather than revealed one surprise at a time. */
function Progress({ at, done }) {
  return (
    <ol className="ledger" style={{ listStyle: 'none', padding: 0, margin: '18px 0 0' }}>
      {STEPS.map((label, i) => (
        <li
          key={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 2px',
            opacity: i === at ? 1 : done[i] ? 0.75 : 0.4,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              flex: '0 0 18px',
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 700,
              background: done[i] ? 'var(--accent)' : i === at ? 'var(--neutral)' : 'transparent',
              border: done[i] ? 'none' : '1.5px solid var(--rule-strong)',
              color: 'var(--accent-ink)',
            }}
          >
            {done[i] ? '✓' : i + 1}
          </span>
          <span style={{ fontSize: 13, fontWeight: i === at ? 600 : 400 }}>{label}</span>
        </li>
      ))}
    </ol>
  )
}

const Step = ({ title, children }) => (
  <>
    <h2 className="section">{title}</h2>
    <div className="panel">{children}</div>
  </>
)

/**
 * A link to a dashboard page, drawn as a button rather than underlined text.
 *
 * These sit next to the step's own action, and a text link beside a button
 * reads as the smaller, more optional of the two — which is backwards here.
 * Opening the page is what you do first; checking is what you do after.
 */
const Open = ({ href, children }) => (
  <a className="btn ghost small" href={href} target="_blank" rel="noreferrer">
    {children}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  </a>
)

/**
 * @param onConnected called with the verified config once every step passes
 */
export default function ByoSetup({ userId, initial, onConnected }) {
  const [at, setAt] = useState(0)
  const [done, setDone] = useState([false, false, false, false])
  const [form, setForm] = useState({ url: initial?.url ?? '', anonKey: initial?.anonKey ?? '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)

  const config = { kind: 'byo', url: normaliseUrl(form.url), anonKey: form.anonKey.trim() }

  const pass = (i) => {
    setDone((d) => d.map((v, n) => (n === i ? true : v)))
    setAt(i + 1)
    setErr(null)
  }

  async function copySql() {
    setErr(null)
    try {
      await navigator.clipboard.writeText(SETUP_SQL)
      setNote('Copied. Paste it into the SQL editor and press Run.')
    } catch {
      setNote(null)
      setErr('This browser blocked the clipboard. Open db/byo-setup.sql in the repo and copy it by hand.')
    }
  }

  /** Steps 2 and 3 ask the same three questions and read different answers out
   *  of them — see probeByo. */
  async function check(step) {
    setErr(null)
    setNote(null)

    const shape = urlProblem(form.url) ?? keyProblem(form.anonKey)
    if (shape) return setErr(shape)

    setBusy(true)
    try {
      const seen = await probeByo(config)
      if (!seen.reachable || !seen.keyValid) return setErr(seen.message)
      // Step 2 only needs the project to exist and the key to be accepted. A
      // table that is not there yet is the *next* step's job, not a failure of
      // this one.
      if (step === 1) return pass(1)
      if (seen.missing.length) {
        return setErr(`${seen.message} Run the whole file — it is one paste, top to bottom.`)
      }
      pass(2)
    } catch (e) {
      setErr(e?.message ?? 'That check could not be run.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * The last step verifies itself by doing the real thing: creating the account
   * Hisaab keeps in their project. If Confirm email is still on, that is
   * exactly where it fails, and the error names the setting.
   */
  async function finish() {
    setErr(null)
    setNote(null)
    setBusy(true)
    try {
      const backend = await createBackend(config, userId)
      const ready = await backend.ready()
      if (!ready.ok) throw new Error(ready.message ?? 'The tables are not all there yet.')
      pass(3)
      onConnected(config, backend)
    } catch (e) {
      setErr(e?.message ?? 'Hisaab could not get into that project.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Progress at={at} done={done} />

      {at === 0 && (
        <Step title="1. Create the project">
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            A free Supabase project. Pick the region nearest you — that is where your money data
            physically lives, and it is the one choice here you cannot change later without
            starting over.
          </p>
          <NewProject />
          <p className="muted" style={{ fontSize: 12, margin: '4px 2px 0', lineHeight: 1.6 }}>
            It also asks for a database password. Save it somewhere — Hisaab never needs it, but
            you will if you ever open the database yourself.
          </p>
          <div className="setup-actions">
            <Open href={LINKS.create}>Create a project</Open>
            <button className="btn small" onClick={() => pass(0)}>
              It’s ready
            </button>
          </div>
        </Step>
      )}

      {at === 1 && (
        <Step title="2. Connect it">
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            Two values, from two pages. First the <b>Project ID</b> — Project Settings → General.
          </p>
          <ProjectId />
          <label className="field">
            <span>Project ID</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="abcdefghijklmnopqrst"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
          <p className="muted" style={{ fontSize: 12, margin: '0 2px 0', lineHeight: 1.6 }}>
            A full <code>https://….supabase.co</code> URL works too, if you are self-hosting or
            already had one copied.
          </p>

          <p className="muted" style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.6 }}>
            Then the key — Settings → <b>API Keys</b>. It opens on the wrong tab: switch to{' '}
            <b>Legacy anon, service_role API keys</b> and copy the <b>anon public</b> one. Never
            service_role: that key ignores every security rule in your database and must not leave
            your dashboard.
          </p>
          <ApiKeys />
          <label className="field">
            <span>Anon public key</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="eyJhbGciOi… or sb_publishable_…"
              value={form.anonKey}
              onChange={(e) => setForm({ ...form, anonKey: e.target.value })}
            />
          </label>
          <div className="setup-actions">
            <Open href={LINKS.general}>Project ID</Open>
            <Open href={LINKS.keys}>API keys</Open>
            <button
              className="btn small"
              disabled={busy || !form.url || !form.anonKey}
              onClick={() => check(1)}
            >
              {busy ? 'Checking…' : 'Check connection'}
            </button>
          </div>
        </Step>
      )}

      {at === 2 && (
        <Step title="3. Create the tables">
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            One paste, top to bottom. It makes the four tables and switches on the security rules
            that stop anyone but you reading them. Nothing to hunt for — copy, open the editor,
            paste, press <b>Run</b>.
          </p>
          <div className="setup-actions">
            <button className="btn ghost small" onClick={copySql}>
              Copy the SQL
            </button>
            <Open href={LINKS.sql}>SQL editor</Open>
            <button className="btn small" disabled={busy} onClick={() => check(2)}>
              {busy ? 'Checking…' : 'I’ve run it'}
            </button>
          </div>
        </Step>
      )}

      {at === 3 && (
        <Step title="4. Let Hisaab in">
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            Hisaab keeps one account inside your project so your database can tell it apart from a
            stranger. Two switches under <b>User Signups</b> let it create that account:{' '}
            <b>Allow new users to sign up</b> on, and <b>Confirm email</b> off — the second because
            your project has no way to send itself a confirmation. Then press{' '}
            <b>Save changes</b>, or neither of them took.
          </p>
          <ConfirmEmail />
          <p className="muted" style={{ fontSize: 12, margin: '4px 2px 0', lineHeight: 1.6 }}>
            <b>Sign-ups only need to be on for this one step.</b> Press Done below, then go back and
            switch it off again — Hisaab signs in with a password from then on, on this device and
            every other one, and never needs to create that account twice.
          </p>
          <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
            You still sign in to Hisaab exactly as you do now. The account this makes is not a
            login — it is how the app reaches a database you own.
          </p>
          <div className="setup-actions">
            <Open href={LINKS.auth}>Auth settings</Open>
            <button className="btn small" disabled={busy} onClick={finish}>
              {busy ? 'Connecting…' : 'Done — connect'}
            </button>
          </div>
        </Step>
      )}

      {at > 0 && at < 4 && (
        <p style={{ marginTop: 12 }}>
          <button className="linkish quiet" onClick={() => setAt(at - 1)}>
            Back a step
          </button>
        </p>
      )}

      {note && <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>{note}</p>}
      {err && <p className="alert" style={{ fontSize: 13, marginTop: 14 }}>{err}</p>}
    </>
  )
}
