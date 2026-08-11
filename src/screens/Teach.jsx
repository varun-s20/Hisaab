import { useEffect, useState } from 'react'
import { listUntaught, recategoriseMerchant } from '../lib/db'
import { learn } from '../lib/categorise'
import { postJson } from '../lib/api'
import { CATEGORIES, allCategories } from '../lib/categories'
import CategoryPicker from '../components/CategoryPicker.jsx'
import ScreenHeader from '../components/ScreenHeader.jsx'
import { seedLookup, TYPE_FOR_CATEGORY } from '../lib/seeds'
import { money } from '../lib/format'

// BUILD_GUIDE §7.5 — the only recurring input the app asks for, and it shrinks
// to nothing. Eight is a session; anything longer is the queue this screen
// exists to prevent. The rest are still there next week.
const MAX = 8

/** One batched call, merchant names only — same guarantee as the import path.
 *  The category list rides along so a category you invented is one the model
 *  can actually pick; it lives in localStorage, which the server can't see. */
async function suggest(merchants) {
  const categories = allCategories()
  const body = await postJson('/api/categorise', { merchants: merchants.slice(0, 50), categories })
  // No suggestions is fine. The picker still works.
  return Object.fromEntries(
    (body?.results ?? [])
      .filter((x) => categories.includes(x.category))
      .map((x) => [x.merchant, x.category]),
  )
}

export default function Teach({ onChange, onBack }) {
  const [rows, setRows] = useState(null) // null until the first load lands
  const [picks, setPicks] = useState({}) // payee_raw → category, what Save writes
  const [suggested, setSuggested] = useState({}) // which of those came from the AI
  const [saving, setSaving] = useState(null) // { done, total } while Save runs
  const [toast, setToast] = useState(null)
  // Kept out of the toast: a toast clears itself, and "couldn't load" is a state
  // the screen has to keep saying until someone retries it.
  const [loadErr, setLoadErr] = useState(null)

  async function load() {
    setLoadErr(null)
    try {
      const next = await listUntaught()
      setRows(next)

      // Seed first — free and certain. Whatever's left goes to the AI in one
      // batched call. This is the only place a merchant that missed
      // categorisation at import time gets another chance: the import path
      // fails soft, so without this those rows would stay unknown forever.
      const seeded = {}
      const askAbout = []
      for (const r of next.slice(0, MAX)) {
        const seed = seedLookup(r.payee_raw)
        if (seed) seeded[r.payee_raw] = seed
        else askAbout.push(r.payee_raw)
      }
      setPicks(seeded)
      setSuggested({})

      if (askAbout.length > 0) {
        const guesses = await suggest(askAbout)
        if (Object.keys(guesses).length > 0) {
          setPicks((p) => ({ ...guesses, ...p })) // a seed still outranks a guess
          setSuggested(guesses)
        }
      }
    } catch (e) {
      // Not setRows([]) — an empty list means "the map's caught up", which is a
      // claim about rows we never managed to see.
      setLoadErr(e.message || String(e))
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
    const total = taught.length
    let done = 0
    try {
      for (const r of taught) {
        // Sequential on purpose — sixteen writes at once is a burst the server
        // has no reason to absorb. Counted, because a stall at row 5 of 8 with a
        // button that only says "Saving…" is indistinguishable from a hang.
        setSaving({ done, total })
        const category = picks[r.payee_raw]
        // 'user' even for a guess the user didn't edit: they saw it on screen
        // and pressed Save. That's approval, and it should outrank any later
        // AI guess for the same merchant.
        await learn(r.payee_raw, { category, payee_clean: r.payee_raw, source: 'user' })
        // The payoff: every past payment to this merchant is fixed too.
        await recategoriseMerchant(r.payee_raw, {
          category,
          payee_clean: r.payee_raw,
          type: TYPE_FOR_CATEGORY[category] ?? 'expense',
        })
        done += 1
      }
      const p = taught.reduce((s, r) => s + r.count, 0)
      setToast(`Learned ${total}. ${p} past payment${p === 1 ? '' : 's'} recategorised.`)
    } catch (e) {
      // ponytail: no rollback. learn + recategorise are both idempotent, so the
      // rows that didn't land are safe to Save again. Say how far it got — the
      // ones already taught are gone from the list after the reload below, and
      // a bare error message next to a shorter list explains nothing.
      const why = e.message || String(e)
      setToast(done > 0 ? `Saved ${done} of ${total}, then stopped. ${why}` : why)
    } finally {
      setSaving(null)
      // Reload on the failure path too: it is the only thing that shows which
      // rows actually made it.
      await load()
      onChange?.()
    }
  }

  // Blank until the first load lands. A load that failed is not still landing.
  if (rows === null && !loadErr) return <div className="screen" />

  const more = (rows?.length ?? 0) - shown.length

  if (loadErr || shown.length === 0) {
    return (
      <div className="screen">
        <ScreenHeader title="Teach me" onBack={onBack} />
        <div className="card">
          {loadErr ? (
            <div className="card-body">
              <p className="alert" style={{ margin: '0 0 12px' }}>
                Couldn&rsquo;t load this. {loadErr}
              </p>
              <button className="btn ghost small" onClick={load}>
                Try again
              </button>
            </div>
          ) : (
            <p className="empty">Nothing new to teach. The map's caught up.</p>
          )}
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    )
  }

  return (
    <div className="screen">
      <ScreenHeader
        title={`Teach me ${shown.length} thing${shown.length === 1 ? '' : 's'}`}
        onBack={onBack}
      />

      <div className="card">
        <ul className="ledger">
          {shown.map((r) => {
            // Whatever the dropdown shows is what Save writes. A prefilled value
            // that quietly saved nothing would make the dropdown a lie about the
            // button. Clear it back to "— pick —" to skip a row.
            const picked = picks[r.payee_raw]
            return (
              <li key={r.payee_raw}>
                <div className="row teachrow">
                  <div className="who">
                    <div className="name">{r.payee_raw}</div>
                    <div className="meta">
                      <span className="num">
                        <span className="rupee">₹</span>
                        {money(r.total)}
                      </span>
                      {' · '}
                      {r.count} payment{r.count === 1 ? '' : 's'}
                      {suggested[r.payee_raw] && picked === suggested[r.payee_raw] && ' · guessed'}
                    </div>
                  </div>
                  <CategoryPicker
                    compact
                    value={picked ?? ''}
                    placeholder="Pick"
                    onChange={(c) => setPicks((p) => ({ ...p, [r.payee_raw]: c }))}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {more > 0 && <p className="muted" style={{ fontSize: 12 }}>{more} more after these.</p>}

      <button
        className="btn"
        style={{ marginTop: 20 }}
        disabled={saving !== null || taught.length === 0}
        onClick={save}
      >
        {saving ? `Saving ${saving.done + 1} of ${saving.total}…` : 'Save'}
      </button>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
