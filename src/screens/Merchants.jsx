import { useEffect, useMemo, useState } from 'react'
import { listMerchantMap, deleteMerchantMapping, recategoriseMerchant } from '../lib/db'
import { learn, clearMapCache, loadMerchantMap } from '../lib/categorise'
import { TYPE_FOR_CATEGORY } from '../lib/seeds'
import CategoryIcon from '../components/CategoryIcon.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import ScreenHeader from '../components/ScreenHeader.jsx'

// What the app has learned, made visible. Until now merchant_map was invisible:
// one wrong thing the AI decided would file that merchant wrongly forever, and
// Teach would never re-ask because the map already had an answer.

const SOURCE_LABEL = { user: 'you taught it', ai: 'guessed by AI', seed: 'built in' }

export default function Merchants({ onBack, onChange }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(null)
  const [confirming, setConfirming] = useState(null) // payee_pattern awaiting a second tap
  const [toast, setToast] = useState('')

  async function load() {
    setErr('')
    setRows(await listMerchantMap())
  }

  // rows stays null on failure, never []. "Nothing learned yet" would send you
  // off to re-teach a map the app already has and just couldn't reach.
  const attempt = () => load().catch((e) => setErr(e.message ?? String(e)))

  useEffect(() => {
    attempt()
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows ?? []
    return (rows ?? []).filter((r) =>
      `${r.payee_clean} ${r.payee_pattern} ${r.category}`.toLowerCase().includes(needle),
    )
  }, [rows, q])

  /** Correcting a mapping fixes every past payment to that merchant too —
   *  a fix that only applied going forward would leave the history wrong. */
  async function recategorise(row, category) {
    if (!category || category === row.category) return
    setBusy(row.payee_pattern)
    try {
      await learn(row.payee_clean || row.payee_pattern, {
        category,
        payee_clean: row.payee_clean,
        source: 'user',
      })
      await recategoriseMerchant(row.payee_pattern, {
        category,
        payee_clean: row.payee_clean,
        type: TYPE_FOR_CATEGORY[category] ?? 'expense',
      })
      setRows((rs) => rs.map((r) => (r.payee_pattern === row.payee_pattern ? { ...r, category, source: 'user' } : r)))
      setToast(`${row.payee_clean} is ${category} now, past payments included.`)
      onChange?.()
    } catch (e) {
      setToast(e.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  async function forget(row) {
    setConfirming(null)
    setRows((rs) => rs.filter((r) => r.payee_pattern !== row.payee_pattern))
    try {
      await deleteMerchantMapping(row.payee_pattern)
      clearMapCache()
      await loadMerchantMap(true)
      setToast(`Forgot ${row.payee_clean}. Teach will ask about it again.`)
      onChange?.()
    } catch (e) {
      setToast(e.message ?? String(e))
      attempt()
    }
  }

  if (!rows)
    return (
      <div className="screen">
        <ScreenHeader title="What it has learned" onBack={onBack} />
        {err && (
          <div className="card">
            <p className="empty" style={{ paddingBottom: 10 }}>
              Couldn&rsquo;t reach what the app has learned. Nothing has been forgotten — it
              just isn&rsquo;t readable right now.
            </p>
            <p className="alert" style={{ fontSize: 13, textAlign: 'center', margin: '0 0 16px' }}>{err}</p>
            <p style={{ textAlign: 'center', margin: '0 0 24px' }}>
              <button type="button" className="btn ghost small" onClick={attempt}>
                Try again
              </button>
            </p>
          </div>
        )}
      </div>
    )

  return (
    <div className="screen">
      <ScreenHeader title="What it has learned" onBack={onBack} />

      <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
        Every merchant the app can name without asking. Change one and its past
        payments are refiled with it.
      </p>

      {rows.length > 8 && (
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search merchants"
            aria-label="Search merchants"
          />
        </div>
      )}

      {shown.length === 0 && (
        <div className="card">
          <p className="empty">
            {rows.length === 0 ? 'Nothing learned yet. Teach it a few merchants first.' : 'Nothing matches that.'}
          </p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="card">
          <ul className="ledger">
            {shown.map((r) => (
              <li key={r.payee_pattern}>
                <div className="row maprow" data-busy={busy === r.payee_pattern}>
                  <CategoryIcon category={r.category} />
                  <div className="who">
                    <div className="name">{r.payee_clean}</div>
                    <div className="meta">
                      {SOURCE_LABEL[r.source] ?? r.source} · {r.hit_count} use{r.hit_count === 1 ? '' : 's'}
                    </div>
                  </div>
                  {/* Full 40px, not the 30px .sm — forgetting a merchant is
                      permanent, and it sat one stray thumb away from happening. */}
                  <button
                    className="iconbtn"
                    style={{ margin: 0 }}
                    aria-label={`Forget ${r.payee_clean}`}
                    onClick={() => setConfirming(r.payee_pattern)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                {/* Two steps, inline, in the row's own second line — same shape
                    as the delete in EditSheet. A window.confirm() would freeze
                    the page, and the mapping does not come back. */}
                <div className="maprow-edit">
                  {confirming === r.payee_pattern ? (
                    <div className="danger-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                      <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
                        Forget this merchant?
                      </span>
                      <button type="button" className="btn ghost small" onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                      <button
                        type="button"
                        className="btn small destructive"
                        aria-label={`Forget ${r.payee_clean}`}
                        onClick={() => forget(r)}
                      >
                        Forget
                      </button>
                    </div>
                  ) : (
                    <CategoryPicker
                      compact
                      value={r.category}
                      disabled={busy === r.payee_pattern}
                      onChange={(c) => recategorise(r, c)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
