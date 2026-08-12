import { useEffect, useMemo, useState } from 'react'
import {
  accountBalances, listAccounts, listBudgets, setBudget, removeBudget,
  listTransactions, mergeAccount, BALANCE_ROWS,
} from '../lib/db'
import { money, startOfMonth, today, daysInMonth } from '../lib/format'
import ScreenHeader from '../components/ScreenHeader.jsx'
import Amount from '../components/Amount.jsx'
import Select from '../components/Select.jsx'
import Sheet, { EXIT } from '../components/Sheet.jsx'
import Skeleton, { HeroSkeleton } from '../components/Skeleton.jsx'
import { Bar, paceOf } from './Budgets.jsx'

// Where the money is, as opposed to where it went.
//
// Budgets answers "am I okay this month" per category. This answers "what is
// left in Wants", which is a different question and the one an envelope
// budgeter asks daily — you fund Needs / Wants / Recurring Payments out of a
// bank once a month and then spend down. Until `to_account` existed the app
// recorded the funding as an expense from a place called "SBI Bank->Needs" and
// could answer neither half.

const ENVELOPE_HINT =
  'Balance is everything that arrived minus everything that left, all time. Transfers count on both sides — moving your own money changes where it is, not how much there is.'

export default function Accounts({ onBack }) {
  const [balances, setBalances] = useState(null)
  const [budgets, setBudgets] = useState([])
  const [spend, setSpend] = useState([])
  const [names, setNames] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null) // { account, amount }
  const [merging, setMerging] = useState(null) // account name
  const [confirming, setConfirming] = useState(null)

  async function load() {
    setErr('')
    const [b, caps, rows, all] = await Promise.all([
      accountBalances(),
      listBudgets(),
      listTransactions({ from: startOfMonth(), to: today(), limit: 2000 }),
      listAccounts(),
    ])
    setBalances(b)
    setBudgets(caps.filter((c) => c.scope === 'account'))
    setSpend(rows.filter((r) => r.type === 'expense'))
    setNames(all)
  }

  // balances stays null on failure, never []. "No accounts yet" because the
  // network dropped would send you off to re-enter something already there.
  const attempt = () => load().catch((e) => setErr(e.message ?? String(e)))

  useEffect(() => {
    attempt()
  }, [])

  const view = useMemo(() => {
    const now = new Date()
    const dim = daysInMonth(now)
    const dom = now.getDate()
    const capOf = new Map(budgets.map((b) => [b.category, Number(b.amount)]))
    const spentThisMonth = new Map()
    for (const r of spend) {
      if (!r.account) continue
      spentThisMonth.set(r.account, (spentThisMonth.get(r.account) ?? 0) + Number(r.amount))
    }
    const list = (balances ?? []).map((a) => ({
      ...a,
      cap: capOf.get(a.account) ?? null,
      month: spentThisMonth.get(a.account) ?? 0,
    }))
    return { dim, dom, list, held: list.reduce((s, a) => s + a.balance, 0) }
  }, [balances, budgets, spend])

  async function saveCap(account, amount) {
    setBusy(true)
    setErr('')
    try {
      await setBudget(account, amount, 'account')
      setEditing(null)
      await load()
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function dropCap(account) {
    setConfirming(null)
    setBudgets((b) => b.filter((x) => x.category !== account))
    try {
      await removeBudget(account, 'account')
    } catch (e) {
      setErr(e.message ?? String(e))
      attempt()
    }
  }

  async function merge(from, to) {
    setBusy(true)
    setErr('')
    try {
      await mergeAccount(from, to)
      setMerging(null)
      await load()
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!balances)
    return (
      <div className="screen" role="status" aria-label="Loading your accounts">
        <ScreenHeader title="Accounts" onBack={onBack} />
        {!err && (
          <>
            <HeroSkeleton />
            <Skeleton h={190} style={{ marginTop: 14 }} />
          </>
        )}
        {err && (
          <div className="card">
            <p className="empty" style={{ paddingBottom: 10 }}>
              Couldn&rsquo;t work out your balances. Nothing is wrong with the ledger — this
              screen just couldn&rsquo;t read it.
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
      <ScreenHeader title="Accounts" onBack={onBack} />

      {view.list.length === 0 ? (
        <div className="card">
          <p className="empty">
            No accounts yet. Set one on any row — which card, bank or envelope it came out
            of — or import an export that already has them.
          </p>
        </div>
      ) : (
        <>
          <div className="brand" style={{ marginBottom: 14 }}>
            <p className="caption">Held across {view.list.length} accounts</p>
            <Amount value={view.held} className="amount" />
          </div>

          <div className="card">
            <div className="card-head">
              <span>Balances</span>
              <span>{view.list.length}</span>
            </div>
            <div className="card-body" style={{ paddingTop: 4 }}>
              {view.list.map((a) => (
                <div className="budgetrow" key={a.account}>
                  <div className="budgetrow-top">
                    <span className="nm">{a.account}</span>
                    <span className={`num ${a.balance < 0 ? 'alert' : ''}`}>
                      ₹{money(Math.abs(a.balance))}
                      {a.balance < 0 ? ' over' : ''}
                    </span>
                  </div>

                  {a.cap != null && (
                    <>
                      <Bar
                        spent={a.month}
                        limit={a.cap}
                        colour="var(--forest-green)"
                        dom={view.dom}
                        dim={view.dim}
                      />
                      <div className="budgetrow-foot">
                        <span className="num">
                          ₹{money(a.month)} of ₹{money(a.cap)} this month
                        </span>
                        <span
                          className={
                            a.month > a.cap
                              ? 'alert'
                              : a.month > paceOf(a.cap, view.dom, view.dim)
                                ? 'warn'
                                : 'muted'
                          }
                        >
                          {a.month > a.cap
                            ? `₹${money(a.month - a.cap)} over`
                            : `₹${money(a.cap - a.month)} left`}
                        </span>
                      </div>
                    </>
                  )}

                  {confirming === a.account ? (
                    <div className="confirmnote" style={{ margin: '10px 0 0', textAlign: 'left' }}>
                      <p className="muted">Remove the monthly cap on {a.account}?</p>
                      <div className="danger-actions" style={{ justifyContent: 'flex-start' }}>
                        <button type="button" className="btn ghost small" onClick={() => setConfirming(null)}>
                          Keep it
                        </button>
                        <button type="button" className="btn small destructive" onClick={() => dropCap(a.account)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="budgetrow-foot" style={{ gap: 10 }}>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        ₹{money(a.in)} in · ₹{money(a.out)} out
                      </span>
                      <span className="danger-actions" style={{ gap: 8 }}>
                        <button
                          className="linkish"
                          onClick={() =>
                            setEditing({ account: a.account, amount: a.cap == null ? '' : String(a.cap) })
                          }
                        >
                          {a.cap == null ? 'Set a cap' : 'Edit cap'}
                        </button>
                        {a.cap != null && (
                          <button className="linkish quiet" onClick={() => setConfirming(a.account)}>
                            Clear
                          </button>
                        )}
                        <button className="linkish quiet" onClick={() => setMerging(a.account)}>
                          Merge
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

      <p className="muted" style={{ fontSize: 12, marginTop: 18, lineHeight: 1.6 }}>
        {ENVELOPE_HINT} A cap counts spending only, and only this month.
        {view.list.length > 0 && ` Read from your most recent ${BALANCE_ROWS.toLocaleString('en-IN')} rows.`}
      </p>

      {editing && (
        <CapSheet
          initial={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveCap}
        />
      )}

      {merging && (
        <MergeSheet
          from={merging}
          names={names.filter((n) => n !== merging)}
          busy={busy}
          onClose={() => setMerging(null)}
          onMerge={merge}
        />
      )}
    </div>
  )
}

/** A monthly cap on one account. Same contract as BudgetSheet — mounted only
 *  while open, so it always starts on the values it was handed. */
function CapSheet({ initial, busy, onClose, onSave }) {
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
    if (!(n > 0)) return setErr('A monthly amount is needed.')
    onSave(initial.account, n)
  }

  return (
    <Sheet open={showing} onClose={finish} title={`${initial.account} cap`}>
      <form onSubmit={submit}>
        <p className="muted" style={{ marginTop: 0 }}>
          What you mean to spend out of {initial.account} in a month. This is the number you
          fund it with.
        </p>
        <label className="field">
          <span>Monthly limit</span>
          <input
            type="number"
            inputMode="decimal"
            min="1"
            autoFocus
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
          {busy ? 'Saving…' : 'Set cap'}
        </button>
      </form>
    </Sheet>
  )
}

/**
 * Fold one account into another.
 *
 * Free text fragments even behind a picker — an import brings "SBI Bank" and
 * you later type "SBI" — and two names for one pocket means two wrong balances
 * rather than one right one. No undo, so it asks in words rather than with a
 * second button: this rewrites every row that names it.
 */
function MergeSheet({ from, names, busy, onClose, onMerge }) {
  const [into, setInto] = useState('')
  const [showing, setShowing] = useState(true)

  const finish = () => {
    setShowing(false)
    setTimeout(onClose, EXIT)
  }

  return (
    <Sheet open={showing} onClose={finish} title={`Merge ${from}`}>
      <p className="muted" style={{ marginTop: 0 }}>
        Every row that says <b>{from}</b> will say the new name instead, on both sides of a
        transfer. Balances are recalculated from the rows, so they follow. Any monthly cap on{' '}
        <b>{from}</b> is dropped.
      </p>

      <Select
        label="Into"
        value={into}
        onChange={setInto}
        options={names}
        placeholder="Pick an account"
        allowNew
        newLabel="New name"
        newPlaceholder="SBI Bank"
        hint="Or type a name to rename it rather than merge it."
      />

      <p className="warn" style={{ fontSize: 12.5 }}>
        There is no undo. Export first from Import a statement if you want a copy.
      </p>

      <button className="btn" disabled={busy || !into} onClick={() => onMerge(from, into)}>
        {busy ? 'Merging…' : into ? `Merge into ${into}` : 'Pick an account'}
      </button>
    </Sheet>
  )
}
