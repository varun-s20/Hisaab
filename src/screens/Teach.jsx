import { useEffect, useState } from 'react'
import { listUntaught, recategoriseMerchant } from '../lib/db'
import { learn } from '../lib/categorise'
import { CATEGORIES, colorFor } from '../lib/categories'
import { seedLookup, TYPE_FOR_CATEGORY } from '../lib/seeds'
import { money } from '../lib/format'

// BUILD_GUIDE §7.5 — the only recurring input the app asks for, and it shrinks
// to nothing. Eight is a session; anything longer is the queue this screen
// exists to prevent. The rest are still there next week.
const MAX = 8

export default function Teach({ onChange }) {
  const [rows, setRows] = useState(null) // null until the first load lands
  const [picks, setPicks] = useState({}) // payee_raw → category, user-touched only
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  async function load() {
    try {
      const next = await listUntaught()
      setRows(next)
      setPicks({})
    } catch (e) {
      setRows([])
      setToast(e.message || String(e))
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const shown = (rows ?? []).slice(0, MAX)
  const taught = shown.filter((r) => picks[r.payee_raw])

  async function save() {
    if (taught.length === 0) return
    setSaving(true)
    try {
      for (const r of taught) {
        const category = picks[r.payee_raw]
        await learn(r.payee_raw, { category, payee_clean: r.payee_raw, source: 'user' })
        // The payoff: every past payment to this merchant is fixed too.
        await recategoriseMerchant(r.payee_raw, {
          category,
          payee_clean: r.payee_raw,
          type: TYPE_FOR_CATEGORY[category] ?? 'expense',
        })
      }
      const n = taught.length
      const p = taught.reduce((s, r) => s + r.count, 0)
      setToast(`Learned ${n}. ${p} past payment${p === 1 ? '' : 's'} recategorised.`)
      await load()
      onChange?.()
    } catch (e) {
      // ponytail: no rollback, no retry loop. learn + recategorise are both
      // idempotent, so the picks stay on screen and Save again is safe.
      setToast(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  if (rows === null) return <div className="screen" />

  const more = rows.length - shown.length

  if (shown.length === 0) {
    return (
      <div className="screen">
        <p className="empty">Nothing new to teach. The map's caught up.</p>
        {toast && <div className="toast">{toast}</div>}
      </div>
    )
  }

  return (
    <div className="screen">
      <h1 className="title">
        Teach me {shown.length} thing{shown.length === 1 ? '' : 's'}
      </h1>

      <ul className="ledger">
        {shown.map((r) => {
          // A seed guess is a suggestion, not a decision — an untouched row is
          // skipped on save. Teaching nothing is a valid outcome.
          const picked = picks[r.payee_raw]
          const value = picked ?? seedLookup(r.payee_raw) ?? ''
          return (
            <li className="row" key={r.payee_raw}>
              <span className="dot" style={picked ? { background: colorFor(picked) } : undefined} />
              <div className="who">
                <div className="name num">{r.payee_raw}</div>
                <div className="meta">
                  <span className="num">
                    <span className="rupee">₹</span>
                    {money(r.total)}
                  </span>
                  {' · '}
                  {r.count} payment{r.count === 1 ? '' : 's'}
                </div>
              </div>
              <select
                aria-label={`Category for ${r.payee_raw}`}
                value={value}
                onChange={(e) => setPicks((p) => ({ ...p, [r.payee_raw]: e.target.value }))}
              >
                <option value="">— pick —</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </li>
          )
        })}
      </ul>

      {more > 0 && <p className="muted" style={{ fontSize: 12 }}>{more} more after these.</p>}

      <button
        className="btn"
        style={{ marginTop: 20 }}
        disabled={saving || taught.length === 0}
        onClick={save}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
