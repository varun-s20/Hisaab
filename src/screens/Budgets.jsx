import { useEffect, useMemo, useState } from 'react'
import { listBudgets, setBudget, removeBudget, listTransactions, TOTAL_BUDGET } from '../lib/db'
import { money, startOfMonth, today, daysInMonth, spendTotal } from '../lib/format'
import { allCategories, colorFor } from '../lib/categories'
import CategoryIcon from '../components/CategoryIcon.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import ScreenHeader from '../components/ScreenHeader.jsx'
import Amount from '../components/Amount.jsx'
import Sheet, { EXIT } from '../components/Sheet.jsx'
import Skeleton, { HeroSkeleton } from '../components/Skeleton.jsx'

// The only number in the app the ledger cannot derive. Everything else answers
// "what happened"; this is the one that answers "am I okay".

/** Where you should be by now if the month were spent evenly. */
const paceOf = (limit, dom, dim) => (limit / dim) * dom

function Bar({ spent, limit, colour, dom, dim }) {
  const pct = Math.min(100, (spent / limit) * 100)
  const pace = Math.min(100, (paceOf(limit, dom, dim) / limit) * 100)
  const over = spent > limit
  return (
    <div className="budgetbar">
      <i style={{ width: `${pct}%`, background: over ? 'var(--negative)' : colour }} />
      {/* Where an even spend would have you today. Being left of it is the
          whole point — a bar with no target is just a percentage. */}
      <span className="pace" style={{ left: `${pace}%` }} aria-hidden="true" />
    </div>
  )
}

export default function Budgets({ onBack }) {
  const [budgets, setBudgets] = useState(null)
  const [rows, setRows] = useState([])
  // { category, amount, isNew } — one sheet does both jobs. It used to be an
  // inline form under the cards, which left the whole month card and the
  // category card sitting above a form that pushed the Save button off-screen
  // on a phone; a sheet covers them the way every other form in the app does.
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(null) // category awaiting a second tap

  async function load() {
    setErr('')
    const [b, r] = await Promise.all([
      listBudgets(),
      listTransactions({ from: startOfMonth(), to: today(), limit: 2000 }),
    ])
    setBudgets(b)
    setRows(r)
  }

  // budgets stays null on failure, never []. "No budgets yet" next to a red
  // error line is the app arguing with itself, and the reassuring half is wrong.
  const attempt = () => load().catch((e) => setErr(e.message ?? String(e)))

  useEffect(() => {
    attempt()
  }, [])

  const view = useMemo(() => {
    const now = new Date()
    const dim = daysInMonth(now)
    const dom = now.getDate()
    const spend = rows.filter((r) => r.type === 'expense')
    const byCat = new Map()
    for (const r of spend) {
      const c = r.category ?? 'Other'
      byCat.set(c, (byCat.get(c) ?? 0) + Number(r.amount))
    }
    const total = spendTotal(spend)
    const list = (budgets ?? [])
      .filter((b) => b.category !== TOTAL_BUDGET)
      .map((b) => ({ ...b, amount: Number(b.amount), spent: byCat.get(b.category) ?? 0 }))
      .sort((a, b) => b.spent / b.amount - a.spent / a.amount)
    const overall = (budgets ?? []).find((b) => b.category === TOTAL_BUDGET)
    return { dim, dom, list, total, overall: overall ? Number(overall.amount) : null }
  }, [budgets, rows])

  async function save(category, amount) {
    setBusy(true)
    setErr('')
    try {
      await setBudget(category, amount)
      setEditing(null)
      await load()
    } catch (e2) {
      setErr(e2.message ?? String(e2))
    } finally {
      setBusy(false)
    }
  }

  async function drop(category) {
    setConfirming(null)
    setBudgets((b) => b.filter((x) => x.category !== category))
    try {
      await removeBudget(category)
    } catch (e) {
      setErr(e.message ?? String(e))
      attempt()
    }
  }

  const taken = new Set((budgets ?? []).map((b) => b.category))
  const free = allCategories().filter((c) => !taken.has(c))

  if (!budgets)
    return (
      <div className="screen" role="status" aria-label="Loading your budgets">
        <ScreenHeader title="Budgets" onBack={onBack} />
        {/* Only while it is still coming. A failure has its own card below and
            must not sit under a placeholder that says "nearly there". */}
        {!err && (
          <>
            <HeroSkeleton />
            <Skeleton h={190} style={{ marginTop: 14 }} />
          </>
        )}
        {err && (
          <div className="card">
            <p className="empty" style={{ paddingBottom: 10 }}>
              Couldn&rsquo;t load your budgets. Whatever you set is still there — it just
              isn&rsquo;t readable right now.
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

  const left = view.overall == null ? null : view.overall - view.total
  const daysLeft = view.dim - view.dom

  return (
    <div className="screen">
      <ScreenHeader title="Budgets" onBack={onBack} />

      {view.overall != null && (
        <div className="brand" style={{ marginBottom: 14 }}>
          <p className="caption">{left >= 0 ? 'Left this month' : 'Over this month'}</p>
          <Amount value={Math.abs(left)} className="amount" />
          <hr />
          <div className="foot">
            <div>
              <span className="k">Spent of ₹{money(view.overall)}</span>
              <b className="num">₹{money(view.total)}</b>
            </div>
            <div>
              <span className="k">Days left</span>
              <b className="num">{daysLeft}</b>
            </div>
          </div>
          {/* The whole-month cap had no controls at all — it could be set once
              and never changed or cleared, which is the one budget most likely
              to be wrong on the first go. */}
          {confirming === TOTAL_BUDGET ? (
            <div className="brand-actions">
              <p>Remove the whole-month budget?</p>
              <div className="danger-actions">
                <button type="button" className="btn ghost small" onClick={() => setConfirming(null)}>
                  Keep it
                </button>
                <button type="button" className="btn small destructive" onClick={() => drop(TOTAL_BUDGET)}>
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="brand-actions">
              <div className="danger-actions">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setEditing({ category: TOTAL_BUDGET, amount: String(view.overall) })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setConfirming(TOTAL_BUDGET)}
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {view.overall == null && view.list.length === 0 && (
        <div className="card">
          <p className="empty">
            No budgets yet. Set one and every category gets a target to sit under.
          </p>
        </div>
      )}

      {view.list.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span>This month</span>
            <span>{view.list.length}</span>
          </div>
          <div className="card-body" style={{ paddingTop: 4 }}>
            {view.list.map((b) => {
              const over = b.spent > b.amount
              const pace = paceOf(b.amount, view.dom, view.dim)
              return (
                <div className="budgetrow" key={b.category}>
                  <div className="budgetrow-top">
                    <CategoryIcon category={b.category} className="tile sm" />
                    <span className="nm">{b.category}</span>
                    <button
                      className="btn ghost small"
                      onClick={() => setEditing({ category: b.category, amount: String(b.amount) })}
                    >
                      Edit
                    </button>
                    {/* Full 40px, not the 30px .sm — this deletes the only
                        number in the app the ledger cannot derive again. */}
                    <button
                      className="iconbtn"
                      style={{ margin: 0 }}
                      aria-label={`Remove budget for ${b.category}`}
                      onClick={() => setConfirming(b.category)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <Bar spent={b.spent} limit={b.amount} colour={colorFor(b.category)} dom={view.dom} dim={view.dim} />
                  {/* The question sits on its own line above the buttons. Side
                      by side they needed 320px and a phone card is under 300,
                      so "Remove" wrapped onto a second row on its own and the
                      pair stopped reading as one choice. */}
                  {confirming === b.category ? (
                    <div className="confirmnote" style={{ margin: '10px 0 0', textAlign: 'left' }}>
                      <p className="muted">Remove this budget?</p>
                      <div className="danger-actions" style={{ justifyContent: 'flex-start' }}>
                        <button type="button" className="btn ghost small" onClick={() => setConfirming(null)}>
                          Keep it
                        </button>
                        <button
                          type="button"
                          className="btn small destructive"
                          aria-label={`Remove budget for ${b.category}`}
                          onClick={() => drop(b.category)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="budgetrow-foot">
                      <span className="num">
                        ₹{money(b.spent)} of ₹{money(b.amount)}
                      </span>
                      <span className={over ? 'alert' : b.spent > pace ? 'warn' : 'muted'}>
                        {over
                          ? `₹${money(b.spent - b.amount)} over`
                          : b.spent > pace
                            ? 'ahead of pace'
                            : `₹${money(b.amount - b.spent)} left`}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

      <button
        className="btn ghost"
        style={{ marginTop: 14 }}
        disabled={free.length === 0 && taken.has(TOTAL_BUDGET)}
        onClick={() => setEditing({ category: '', amount: '', isNew: true })}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Set a budget
      </button>

      <p className="muted" style={{ fontSize: 12, marginTop: 18, lineHeight: 1.6 }}>
        Budgets are monthly and count spending only — transfers, refunds, investments and
        money you lent never touch them. The notch on each bar is where an even spend
        would put you today.
      </p>

      {editing && (
        <BudgetSheet
          initial={editing}
          busy={busy}
          totalTaken={taken.has(TOTAL_BUDGET)}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

/** Set or change one budget. Mounted only while open, so it always starts on
 *  the values it was handed — same contract as EditSheet. */
function BudgetSheet({ initial, busy, totalTaken, onClose, onSave }) {
  const [cat, setCat] = useState(initial.category)
  const [amount, setAmount] = useState(initial.amount)
  const [err, setErr] = useState('')
  const [showing, setShowing] = useState(true)

  const finish = () => {
    setShowing(false)
    setTimeout(onClose, EXIT)
  }

  function submit(e) {
    e.preventDefault()
    const n = Number(amount)
    if (!cat) return setErr('Pick a category, or choose the whole month.')
    if (!(n > 0)) return setErr('A monthly amount is needed.')
    onSave(cat, n)
  }

  const title = initial.isNew
    ? 'Set a budget'
    : cat === TOTAL_BUDGET
      ? 'Whole-month budget'
      : `${cat} budget`

  return (
    <Sheet open={showing} onClose={finish} title={title}>
      <form onSubmit={submit}>
        {initial.isNew && (
          <>
            <div className="field">
              <span>What</span>
              {/* role="tab" without a tablist around it is invalid, and it is
                  the aria-selected the chip styling hangs off. */}
              <div className="chips" role="tablist" aria-label="What to budget" style={{ marginBottom: 0 }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={cat === TOTAL_BUDGET}
                  onClick={() => setCat(TOTAL_BUDGET)}
                  disabled={totalTaken}
                >
                  The whole month
                </button>
              </div>
            </div>
            <CategoryPicker
              label="Or one category"
              placeholder="Pick a category"
              value={cat === TOTAL_BUDGET ? '' : cat}
              onChange={setCat}
            />
          </>
        )}

        <label className="field">
          <span>Monthly limit</span>
          <input
            type="number"
            inputMode="decimal"
            min="1"
            autoFocus={!initial.isNew}
            className="num"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              setErr('')
            }}
            placeholder="0"
          />
        </label>

        {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : initial.isNew ? 'Set budget' : 'Save'}
        </button>
      </form>
    </Sheet>
  )
}
