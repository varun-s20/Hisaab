import { useEffect, useState } from 'react'
import { currentUserId } from '../lib/auth'
import { readConfig, writeConfig } from '../lib/backend'
import { createBackend, looksPaused, rlsLooksOff } from '../lib/backends/index.js'
import { activeAdapter, activeBackendConfig, installBackend } from '../lib/db'
import { clearMapCache } from '../lib/categorise'
import { loadCategories } from '../lib/categories'
import { migrate } from '../lib/migrate'
import { backup, downloadBackup, readBackupFile, restore } from '../lib/export'
import { forgetKey, keyProblem as geminiKeyProblem, readKey, writeKey } from '../lib/ai'
import ScreenHeader from '../components/ScreenHeader.jsx'
import ByoSetup from './ByoSetup.jsx'

// Where your data lives.
//
// Three backends, one interface (lib/db.js). This screen is the only place a
// person changes which one is live, and the only place the trade-offs are
// spelled out — each option says what it costs as well as what it gives, on the
// grounds that somebody choosing where their money is stored deserves the whole
// sentence rather than the flattering half.
//
// Signing in is NOT part of this choice. Every user signs in to Hisaab whatever
// they pick here; see lib/auth.js. Connecting a project of their own is a job
// of its own and lives in ByoSetup.jsx.

const OPTIONS = [
  {
    kind: 'cloud',
    label: 'Hisaab cloud',
    sub: 'The default. Stored on our Supabase, in one region, backed up by us.',
    detail:
      'Simplest, and the only one where you have nothing to maintain. The honest limit: we hold the keys to this database, so we can read what is in it.',
  },
  {
    kind: 'byo',
    label: 'Your own Supabase',
    sub: 'Your project, your region, your backups. We hold no key to it.',
    detail:
      'Four steps, about three minutes, and Hisaab checks each one before moving on. Needs a free Supabase account. A free project pauses after roughly a week unused, and Hisaab will say so when it happens rather than looking broken.',
  },
  {
    kind: 'local',
    label: 'This device',
    sub: 'Nowhere but this phone. No account, no network, no cloud.',
    detail:
      'Nothing leaves the device. In exchange there is no copy anywhere else: clearing this site’s data, or the browser reclaiming storage, takes the ledger with it. Keep the backup file.',
  },
]

const labelOf = (kind) => OPTIONS.find((o) => o.kind === kind)?.label ?? kind

export default function Storage({ onBack }) {
  const [userId, setUserId] = useState(null)
  const [live, setLive] = useState(activeBackendConfig())
  const [choice, setChoice] = useState(null) // the kind being switched to
  // Set once a project of their own has passed every step of ByoSetup. Holds
  // the backend it already opened, so committing the switch does not sign in
  // to their project a second time.
  const [connected, setConnected] = useState(null)
  const [mode, setMode] = useState('copy') // copy | move
  const [backedUp, setBackedUp] = useState(false)
  const [busy, setBusy] = useState(null) // a progress word while working
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(null)
  const [geminiKey, setGeminiKey] = useState('')

  // True when the backend the app is on cannot be opened at all — a Supabase
  // project that is paused or deleted, storage the browser has blocked.
  //
  // Without this, that state is a trap. Switching reads the source first and
  // saving a backup reads it too, so a dead backend disabled both the way out
  // and the thing standing in front of the way out. The one screen that can
  // move somebody off a broken backend required the broken backend to answer.
  const [sourceBroken, setSourceBroken] = useState(false)

  useEffect(() => {
    currentUserId().then((id) => {
      setUserId(id)
      if (id) {
        setLive(readConfig(id))
        setGeminiKey(readKey(id) ?? '')
      }
    })
    activeAdapter().then(
      () => setSourceBroken(false),
      () => setSourceBroken(true),
    )
  }, [])

  const target = OPTIONS.find((o) => o.kind === choice)
  // A project of their own has to be connected and verified before there is
  // anything to switch to. The other two are ready the moment they are picked.
  const readyToSwitch = choice && (choice !== 'byo' || connected)

  function pick(kind) {
    setErr(null)
    setDone(null)
    setBackedUp(false)
    setConnected(null)
    setMode('copy')
    setChoice(kind === live.kind ? null : kind)
  }

  function saveKey() {
    setErr(null)
    setDone(null)
    const problem = geminiKeyProblem(geminiKey)
    if (problem) return setErr(problem)
    // writeKey throws without one, and an unhandled throw out of an onClick is
    // a dead button rather than a message.
    if (!userId) return setErr('Sign in first.')
    writeKey(userId, geminiKey)
    forgetKey() // the in-memory copy in lib/ai.js is now a session behind
    setDone(geminiKey ? 'Saved. The AI now runs on your key.' : 'Cleared. Back to Hisaab’s AI.')
  }

  /** The backup is not optional and not a checkbox. It is the file that makes
   *  every step after this reversible, including the one that deletes. */
  async function saveBackup() {
    setErr(null)
    setDone(null)
    try {
      downloadBackup(await backup())
      setBackedUp(true)
      setDone('Backup saved. Keep it somewhere that is not this device.')
    } catch (e) {
      setErr(e?.message ?? 'The backup could not be written.')
    }
  }

  /**
   * Put a file back. Adds what is missing and touches nothing else — see
   * restore() — so this needs no confirmation step and no warning, because
   * there is no outcome here that loses anything.
   */
  async function restoreBackup(event) {
    const file = event.target.files?.[0]
    // Cleared straight away so picking the same file twice fires again, which
    // is what someone does after a failure they have just fixed.
    event.target.value = ''
    if (!file) return

    setErr(null)
    setDone(null)
    setBusy('reading')
    try {
      const report = await restore(await readBackupFile(file))
      clearMapCache()
      await loadCategories().catch(() => {})

      const added = [
        [report.transactions.copied, 'transactions'],
        [report.categories.copied, 'categories'],
        [report.budgets.copied, 'budgets'],
        [report.merchants.copied, 'merchants'],
      ].filter(([n]) => n > 0)

      setDone(
        added.length
          ? `Restored ${added.map(([n, what]) => `${n} ${what}`).join(', ')}. Nothing already here was changed.`
          : 'Everything in that file was already here. Nothing changed.',
      )
    } catch (e) {
      setErr(e?.message ?? 'That backup could not be restored.')
    } finally {
      setBusy(null)
    }
  }

  async function switchTo() {
    setErr(null)
    setDone(null)

    const config = connected?.config ?? { kind: choice }
    try {
      setBusy('connecting')

      // Best effort. An unreachable source is not a reason to refuse the
      // switch — it is the reason somebody is on this screen.
      let source = null
      try {
        source = await activeAdapter()
      } catch {
        setSourceBroken(true)
      }

      const destination = connected?.backend ?? (await createBackend(config, userId))

      const check = await destination.ready()
      if (!check.ok) throw new Error(check.message ?? 'That storage could not be opened.')

      const report = source
        ? await migrate(source, destination, { mode, onProgress: (stage) => setBusy(stage) })
        : null

      installBackend(destination, config)
      writeConfig(userId, config)
      // Both of these are cached outside React and belong to the backend they
      // were read from. Left alone, the old backend's merchant mappings would
      // be applied to the new one's rows, and its categories would sit in every
      // picker, until the next reload.
      clearMapCache()
      await loadCategories().catch(() => {})
      setLive(config)
      setChoice(null)
      setConnected(null)

      if (!report) {
        setDone(
          `Switched to ${labelOf(config.kind)}. The old storage could not be reached, so nothing ` +
            'was copied and nothing there was touched — it is all still where it was. Reconnect it ' +
            'later, or restore a backup file below.',
        )
      } else {
        const moved = `${report.transactions.copied} moved across` +
          (report.transactions.skipped ? `, ${report.transactions.skipped} already there` : '')
        setDone(
          report.blocked
            ? `${moved}. ${report.blocked}`
            : report.cleared
              ? `${moved}. The old copy has been deleted.`
              : `${moved}. The old copy is still where it was.`,
        )
      }
      setSourceBroken(false)

      // Asked once the rows are actually there, because an empty table answers
      // an unauthenticated caller with nothing whether it is protected or not.
      // Loud, and in the error slot rather than as a note: an unprotected
      // project means their whole ledger is readable by anyone holding the key,
      // which is the opposite of what they came to this screen for.
      if (config.kind === 'byo' && (await rlsLooksOff(config))) {
        setErr(
          'Warning: your project answered without being signed in, which means row level security is not protecting it. ' +
            'Anyone with your project ID and anon key could read this ledger. Re-run the setup SQL — the last part of it turns that on.',
        )
      }
    } catch (e) {
      setErr(
        looksPaused(e)
          ? 'That project did not answer. A free Supabase project pauses after about a week unused — open your dashboard and resume it, then try again.'
          : (e?.message ?? 'That did not work. Nothing was changed.'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="screen">
      <ScreenHeader title="Where your data lives" onBack={onBack} />

      <p className="muted" style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.6 }}>
        You always sign in to Hisaab the same way. This only changes where your transactions,
        categories, budgets and merchant map are stored.
      </p>
      {/* Said out loud because it surprises people, and because it cannot be
          fixed without storing their project key in our cloud — which is the
          exact thing bringing your own database exists to avoid. */}
      <p className="muted" style={{ margin: '0 0 18px', fontSize: 12, lineHeight: 1.6 }}>
        This choice is per device. A project of your own has to be connected on each phone or
        laptop you use, because its key stays on the device and never reaches us.
      </p>

      <div className="card">
        <ul className="ledger">
          {OPTIONS.map((o) => (
            <li key={o.kind}>
              <button className="row menurow" onClick={() => pick(o.kind)} disabled={Boolean(busy)}>
                <span className="who">
                  <span className="name">
                    {o.label}
                    {live.kind === o.kind && (
                      <span className="badge solo" style={{ marginLeft: 8 }}>Now</span>
                    )}
                  </span>
                  <span className="meta">{o.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {target && (
        <>
          <h2 className="section">Move to {target.label}</h2>
          <div className="panel">
            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              {target.detail}
            </p>
          </div>

          {choice === 'byo' && !connected && (
            <ByoSetup
              userId={userId}
              initial={live.kind === 'byo' ? live : null}
              onConnected={(config, backend) => {
                setConnected({ config, backend })
                setDone(
                  'Connected, and the tables are there. Nothing has moved yet — and you can turn ' +
                    '“Allow new users to sign up” back off in your project now.',
                )
              }}
            />
          )}

          {readyToSwitch && (
            <>
              <h2 className="section">Before switching</h2>
              {sourceBroken ? (
                // Nothing to back up and nothing at risk: the source cannot be
                // read, so the switch will copy nothing and delete nothing.
                // Demanding a backup here would only lock the exit.
                <div className="panel">
                  <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                    <b>{labelOf(live.kind)} is not answering.</b> You can still switch — nothing
                    will be copied across and nothing there will be touched. Whatever is in it
                    stays put until you reconnect it.
                  </p>
                </div>
              ) : (
                <div className="panel">
                  <div className="switchrow">
                    <label htmlFor="backup-now">
                      <span className="k">{backedUp ? 'Backup saved' : 'Save a backup first'}</span>
                      <span className="sub">Nothing below can be undone without it.</span>
                    </label>
                    <button
                      id="backup-now"
                      className="btn ghost small"
                      onClick={saveBackup}
                      disabled={Boolean(busy)}
                    >
                      {backedUp ? 'Save again' : 'Save'}
                    </button>
                  </div>
                </div>
              )}

              <div className="panel" style={{ marginTop: 10 }}>
                {[
                  ['copy', 'Copy it across', `Leave a copy on ${labelOf(live.kind)}.`],
                  ['move', 'Move it', `Delete it from ${labelOf(live.kind)} once every row has arrived.`],
                ].map(([value, label, sub]) => (
                  <label key={value} className="choicerow">
                    <input
                      type="radio"
                      name="switch-mode"
                      checked={mode === value}
                      onChange={() => setMode(value)}
                    />
                    <span>
                      <span className="k">{label}</span>
                      <span className="sub">{sub}</span>
                    </span>
                  </label>
                ))}
                <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
                  Nothing is deleted until every row has been read back out of the new place. If
                  any of it is missing, both copies are kept and Hisaab says so.
                </p>
              </div>

              <p style={{ marginTop: 18 }}>
                <button
                  className="btn"
                  onClick={switchTo}
                  disabled={Boolean(busy) || (!backedUp && !sourceBroken)}
                >
                  {busy ? `${busy[0].toUpperCase()}${busy.slice(1)}…` : `Switch to ${target.label}`}
                </button>
              </p>
              {!backedUp && !sourceBroken && (
                <p className="muted" style={{ fontSize: 12, textAlign: 'center', margin: '10px 0 0' }}>
                  Save the backup first.
                </p>
              )}
            </>
          )}
        </>
      )}

      <h2 className="section">Backup</h2>
      <div className="panel">
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          One file with everything in it: transactions, categories, budgets and the merchant map.
          Worth having wherever your data lives, and the only copy that exists if you keep it on
          this device.
        </p>
        <div className="setup-actions">
          <button className="btn ghost small" onClick={saveBackup} disabled={Boolean(busy)}>
            Save a backup
          </button>
          {/* A label wrapping a hidden input, because a file input cannot be
              styled and `.click()` from a button is blocked as a programmatic
              file dialog in some browsers. This is the plain-HTML way and it
              works everywhere. */}
          <label className="btn ghost small" style={{ cursor: 'pointer' }}>
            {busy === 'reading' ? 'Restoring…' : 'Restore a backup'}
            <input
              type="file"
              accept="application/json,.json"
              onChange={restoreBackup}
              disabled={Boolean(busy)}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '12px 2px 0', lineHeight: 1.6 }}>
          Restoring adds what is missing and changes nothing that is already here, so it is safe
          to run against a ledger you are still using — and safe to run twice.
        </p>
      </div>

      <h2 className="section">Your own AI key</h2>
      <div className="panel">
        <label className="field">
          <span>Gemini API key</span>
          {/* Same shape as the anon key field in ByoSetup, deliberately. It was
              type="password", which renders as dots and reads as a login — this
              is a key you paste once and check by eye, and the two key fields in
              this app should not look like different kinds of thing. It is
              visible on screen while this panel is open; it is already readable
              by anything running on the page, which the note below says. */}
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            // Short enough to read in the field. The rest of the sentence is
            // below, where there is room for it.
            placeholder="AIza…"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
          />
        </label>
        <p style={{ margin: '4px 0 0' }}>
          <button className="linkish" onClick={saveKey} disabled={Boolean(busy)}>
            {geminiKey ? 'Save key' : 'Use Hisaab’s AI'}
          </button>
        </p>
        <p className="muted" style={{ fontSize: 12, margin: '10px 2px 0', lineHeight: 1.6 }}>
          Leave it empty to use Hisaab’s AI, which is shared and capped per day. With a key of
          your own, merchant names and your questions go straight from this device to Google and
          never touch Hisaab’s servers.
        </p>
        <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
          The key is stored on this device and is readable by anything running on this page. Google
          lets you restrict it to a single site — worth doing.
        </p>
      </div>

      {done && <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>{done}</p>}
      {err && <p className="alert" style={{ fontSize: 13, marginTop: 16 }}>{err}</p>}
    </div>
  )
}
