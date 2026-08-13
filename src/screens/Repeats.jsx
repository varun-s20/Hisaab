import { useEffect, useMemo, useState } from 'react'
import {
  listTemplates, listTransactions, postTemplate, removeTemplate, saveTemplate, templatesSupported,
} from '../lib/db'
import { money, today, dayLabel, endOfMonth, startOfMonth } from '../lib/format'
import { TYPE_OPTIONS, DIRECTIONS, COUNTED } from '../lib/categories'
import { findFrequent, FREQUENT_WINDOW } from '../lib/recurring'
import {
  WEEKDAYS, addDays, committedBetween, committedPerMonth, describeRule, nextDue,
  pendingOccurrences, ruleProblem,
} from '../lib/schedule'
import { seedFromTemplate, templateFromSuggestion } from '../lib/entry'
import ManualEntry from '../components/ManualEntry.jsx'
import ScreenHeader from '../components/ScreenHeader.jsx'
import CategoryIcon from '../components/CategoryIcon.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import DateField from '../components/DateField.jsx'
import Select from '../components/Select.jsx'
import Amount from '../components/Amount.jsx'
import Sheet, { EXIT } from '../components/Sheet.jsx'
import Skeleton, { HeroSkeleton } from '../components/Skeleton.jsx'

// Things that come round.
//
// Two kinds, one table, because they are one idea at different speeds:
//
//   a tile   no schedule. It sits on Today and you tap it. Chai ₹20.
//   a bill   a schedule. Rent on the 5th. It tells you it is due.
//
// Nothing on this screen posts by itself, ever. A bill that came due is an
// offer with a Log it button next to it — an app that invents transactions on
// your behalf is an app whose totals you can no longer trust, and the whole
// value of this ledger is that every row in it is there because someone said so.

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

const UNIT_OPTIONS = [
  { value: 'none', label: 'Never', sub: 'A tile on Today you tap when you buy it' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
  { value: 'year', label: 'Years' },
]

const MONTH_DAYS = [
  ...Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1}` })),
  { value: 'last', label: 'Last day of the month' },
]

const blankRepeat = () => ({
  label: '',
  payee: '',
  amount: '',
  category: '',
  type: 'expense',
  direction: 'debit',
  method: '',
  account: '',
  to_account: '',
  note: '',
  unit: 'none',
  every: 1,
  weekday: new Date().getDay(),
  monthDay: new Date().getDate(),
  starts_on: today(),
  until: '',
})

/** A stored row, as the form edits it. The rule is flattened into fields
 *  because a form edits fields, and folded back by ruleOf below. */
function draftOf(t) {
  const rule = t.rule && !ruleProblem(t.rule) ? t.rule : null
  return {
    ...blankRepeat(),
    id: t.id,
    label: t.label ?? '',
    payee: t.payee ?? '',
    amount: t.amount == null ? '' : String(t.amount),
    category: t.category ?? '',
    type: t.type ?? 'expense',
    direction: t.direction ?? 'debit',
    method: t.method ?? '',
    account: t.account ?? '',
    to_account: t.to_account ?? '',
    note: t.note ?? '',
    unit: rule?.unit ?? 'none',
    every: rule?.every ?? 1,
    weekday: rule?.weekday ?? new Date().getDay(),
    monthDay: rule?.lastDay ? 'last' : (rule?.monthDay ?? new Date().getDate()),
    starts_on: t.starts_on ?? today(),
    until: rule?.until ?? '',
    last_posted_on: t.last_posted_on ?? null,
    pinned: Boolean(t.pinned),
    source: t.source ?? 'user',
  }
}

function ruleOf(d) {
  if (d.unit === 'none') return null
  const rule = { every: Math.max(1, Number(d.every) || 1), unit: d.unit }
  if (d.unit === 'week') rule.weekday = Number(d.weekday)
  if (d.unit === 'month' || d.unit === 'year') {
    if (d.monthDay === 'last') rule.lastDay = true
    else rule.monthDay = Number(d.monthDay)
  }
  if (d.until) rule.until = d.until
  return rule
}

export default function Repeats({ onBack, onChange }) {
  const [templates, setTemplates] = useState(null)
  const [rows, setRows] = useState([])
  const [supported, setSupported] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [posting, setPosting] = useState(null) // { t, on } — an occurrence needing an amount

  async function load() {
    setErr('')
    // Sequenced, not raced. The Supabase backend starts out assuming the table
    // is there and only learns otherwise from a failed read — so asking whether
    // repeats are supported *alongside* the read gets the optimistic answer,
    // and an un-migrated project showed "No tiles yet" and an enabled Add
    // button instead of the line telling you which file to run.
    const list = await listTemplates()
    const ok = await templatesSupported()
    // Only for the suggestions below, which read a sixty-day window — so the
    // query is that window rather than the whole ledger. Failing costs a list
    // of things you might pin, not the repeats you already have.
    const recent = await listTransactions({
      from: addDays(today(), -FREQUENT_WINDOW),
      to: today(),
      limit: 2000,
    }).catch(() => [])

    setSupported(ok)
    setTemplates(list)
    setRows(recent)
  }

  // templates stays null on failure, never []. "Nothing yet" beside a red error
  // line is the app arguing with itself, and the reassuring half is the wrong one.
  const attempt = () => load().catch((e) => setErr(e.message ?? String(e)))

  useEffect(() => {
    attempt()
  }, [])

  const view = useMemo(() => {
    const all = templates ?? []
    const live = all.filter((t) => !t.hidden)
    const bills = live.filter((t) => t.rule)
    const due = bills
      .map((t) => ({ t, dates: pendingOccurrences(t) }))
      .filter((x) => x.dates.length > 0)
    const dueIds = new Set(due.map((x) => x.t.id))
    const upcoming = bills
      .filter((t) => !dueIds.has(t.id) && nextDue(t))
      .sort((a, b) => nextDue(a).localeCompare(nextDue(b)))
    const tiles = live.filter((t) => !t.rule)

    const known = all.map((t) => t.payee)
    const suggestions = findFrequent(rows)
      .filter((s) => !known.some((name) => sameName(name, s.payee)))
      .slice(0, 6)

    return {
      due,
      upcoming,
      tiles,
      suggestions,
      dismissed: all.filter((t) => t.hidden),
      perMonth: committedPerMonth(bills),
      // A different question from perMonth, and the one you plan against: that
      // is what a bill costs averaged over its whole cadence, this is what is
      // actually owed on dates inside THIS month. Windowed from the 1st, or a
      // bill left unconfirmed since June puts June's and July's rent into a
      // figure headed "spending left" — see committedBetween. The unconfirmed
      // ones are already listed by date under "Due now".
      rest: committedBetween(bills, endOfMonth(), { from: startOfMonth() }),
    }
  }, [templates, rows])

  async function run(job) {
    setBusy(true)
    setErr('')
    try {
      await job()
      await load()
      onChange?.()
    } catch (e) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = (d) =>
    run(async () => {
      await saveTemplate({
        id: d.id,
        // Sliced, because the fallback comes from a field that allows 120
        // characters and a label may only be 40. Without it, leaving the
        // optional "Called" box empty for a long payee failed with "that name
        // is too long" — pointing at a field the user never filled in.
        label: (d.label.trim() || d.payee.trim()).slice(0, 40),
        payee: d.payee,
        amount: d.amount,
        category: d.category,
        type: d.type,
        direction: d.direction,
        method: d.method,
        account: d.account,
        to_account: d.to_account,
        note: d.note,
        rule: ruleOf(d),
        starts_on: d.starts_on,
        last_posted_on: d.last_posted_on,
        pinned: d.unit === 'none' ? true : d.pinned,
        source: d.source,
      })
      setEditing(null)
    })

  /**
   * Confirm one occurrence. Writes the payment and moves the bill on.
   *
   * A bill with no agreed amount — the maid, the vegetable bill — has nothing
   * to post, so it opens the form on that occurrence's date instead of writing
   * a row with a null amount. Today's tiles already work this way; this is the
   * same rule for the same reason.
   */
  const logOne = (t, on) => {
    if (t.amount == null) return setPosting({ t, on })
    return run(() => postTemplate(t, { on }))
  }

  /** Stamp an occurrence as dealt with, without rewinding the schedule. */
  const stamp = (t, on) =>
    saveTemplate({
      ...t,
      amount: t.amount ?? '',
      last_posted_on: t.last_posted_on && t.last_posted_on > on ? t.last_posted_on : on,
    })

  /** Move the bill past an occurrence without writing anything. The month the
   *  gym was shut is not a payment, and nagging about it forever is not the
   *  alternative. */
  const skipOne = (t, on) => run(() => stamp(t, on))

  const pin = (suggestion) => run(() => saveTemplate(templateFromSuggestion(suggestion)))

  const drop = (id) =>
    run(async () => {
      setConfirming(null)
      await removeTemplate(id)
      // The sheet is showing a row that no longer exists. Leaving it open lets
      // the next Save write it straight back.
      setEditing(null)
    })

  const restore = (t) => run(() => saveTemplate({ ...t, amount: t.amount ?? '', hidden: false }))

  if (!templates)
    return (
      <div className="screen" role="status" aria-label="Loading your repeats">
        <ScreenHeader title="Repeats" onBack={onBack} />
        {!err && (
          <>
            <HeroSkeleton />
            <Skeleton h={190} style={{ marginTop: 14 }} />
          </>
        )}
        {err && (
          <div className="card">
            <p className="empty" style={{ paddingBottom: 10 }}>
              Couldn&rsquo;t load your repeats. Whatever you set up is still there — it just
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

  return (
    <div className="screen">
      <ScreenHeader title="Repeats" onBack={onBack} />

      {!supported && (
        <div className="card">
          <p className="empty">
            Your database hasn&rsquo;t got a table for these yet. Run{' '}
            <b>db/migrate-templates.sql</b> in your Supabase SQL editor and this screen
            starts working. Nothing else in the app is affected.
          </p>
        </div>
      )}

      {/* Bills, not rupees. Gated on perMonth, somebody whose repeats all have
          no agreed amount — the maid, the sabzi bill, the vegetable man — saw no
          card at all, which took "Due now" with it: the one count on this screen
          that is about something needing to be done. */}
      {view.due.length + view.upcoming.length > 0 && (
        <div className="brand" style={{ marginBottom: 14 }}>
          <p className="caption">Committed every month</p>
          <Amount value={view.perMonth} className="amount" />
          <hr />
          <div className="foot">
            <div>
              <span className="k">Spending left</span>
              <b className="num">₹{money(view.rest.total)}</b>
            </div>
            <div>
              <span className="k">Bills</span>
              <b className="num">{view.due.length + view.upcoming.length}</b>
            </div>
            <div>
              <span className="k">Due now</span>
              <b className="num">{view.due.length}</b>
            </div>
          </div>
          {view.rest.unknown > 0 && (
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 }}>
              Plus {view.rest.unknown} due before the month is out with no set amount — they are
              in neither figure, because guessing one is how a total stops being true.
            </p>
          )}
        </div>
      )}

      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

      {/* ── Due now ─────────────────────────────────────────────────────── */}
      {view.due.length > 0 && (
        <>
          <h2 className="section">Due now</h2>
          <div className="card">
            <div className="card-body" style={{ paddingTop: 4 }}>
              {view.due.map(({ t, dates }) => (
                <div className="budgetrow" key={t.id}>
                  <div className="budgetrow-top">
                    <CategoryIcon category={t.category} className="tile sm" />
                    <span className="nm">{t.label}</span>
                    <span className="num">{t.amount == null ? '—' : `₹${money(t.amount)}`}</span>
                  </div>
                  {/* Only the oldest is actionable, and that is the data model
                      showing through rather than a restriction on top of it: a
                      template remembers one date, `last_posted_on`, and it only
                      ever moves forward. So confirming August on a bill last
                      seen in May would carry June and July past with it and they
                      would leave this list unlogged and unmentioned. Three
                      buttons that quietly meant "and the two above" were the
                      wrong shape for that. Oldest first, one at a time. */}
                  {dates.map((on, i) => (
                    <div className="budgetrow-foot" key={on} style={{ gap: 10 }}>
                      <span className="muted">{dayLabel(on)}</span>
                      {i === 0 ? (
                        <span className="danger-actions" style={{ gap: 8 }}>
                          <button className="linkish" disabled={busy} onClick={() => logOne(t, on)}>
                            Log it
                          </button>
                          <button className="linkish quiet" disabled={busy} onClick={() => skipOne(t, on)}>
                            Skip
                          </button>
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12.5 }}>then this one</span>
                      )}
                    </div>
                  ))}
                  <div className="budgetrow-foot">
                    <span className="muted" style={{ fontSize: 12.5 }}>{describeRule(t.rule)}</span>
                    <button className="linkish quiet" onClick={() => setEditing(draftOf(t))}>
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {view.due.some(({ dates }) => dates.length > 1) && (
            <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
              More than one date on a bill means it went unconfirmed for a while. Oldest first,
              one at a time — log the ones that happened and skip the ones that didn&rsquo;t, and
              the next date appears as you go. Six at a time at most, so a forgotten repeat can
              never post a wall of rows.
            </p>
          )}
        </>
      )}

      {/* ── Upcoming ────────────────────────────────────────────────────── */}
      {view.upcoming.length > 0 && (
        <>
          <h2 className="section">Coming up</h2>
          <div className="card">
            <ul className="ledger">
              {view.upcoming.map((t) => (
                <li key={t.id}>
                  <button className="row" onClick={() => setEditing(draftOf(t))}>
                    <CategoryIcon category={t.category} />
                    <span className="who">
                      <span className="name">{t.label}</span>
                      <span className="meta">
                        {dayLabel(nextDue(t))} · {describeRule(t.rule)}
                      </span>
                    </span>
                    <span className="amt num">
                      {t.amount == null ? '—' : <>₹{money(t.amount)}</>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── Tiles ───────────────────────────────────────────────────────── */}
      <h2 className="section">On the Today screen</h2>
      {view.tiles.length === 0 ? (
        <div className="card">
          {/* Two different empty states, because with suggestions on screen the
              flat "no tiles yet" contradicts both the tiles already showing on
              Today and the paragraph directly below it. */}
          <p className="empty">
            {view.suggestions.length > 0
              ? 'Nothing pinned. The ones below are already on Today, worked out from your rows — pinning keeps one there even after the habit tails off.'
              : 'No tiles yet. A tile is one tap on Today for something you buy constantly — the auto, the chai, the sabzi. Add one, or log the same thing a few times and it will offer itself.'}
          </p>
        </div>
      ) : (
        <div className="card">
          <ul className="ledger">
            {view.tiles.map((t) => (
              <li key={t.id}>
                <button className="row" onClick={() => setEditing(draftOf(t))}>
                  <CategoryIcon category={t.category} />
                  <span className="who">
                    <span className="name">{t.label}</span>
                    <span className="meta">
                      {t.payee}
                      {t.method ? ` · ${t.method}` : ''}
                      {t.account ? ` · ${t.account}` : ''}
                    </span>
                  </span>
                  <span className="amt num">
                    {t.amount == null ? 'Asks' : <>₹{money(t.amount)}</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── What the ledger suggests ────────────────────────────────────── */}
      {view.suggestions.length > 0 && (
        <>
          <h2 className="section">You buy these a lot</h2>
          <div className="card">
            <div className="card-body" style={{ paddingTop: 4 }}>
              {view.suggestions.map((s) => (
                <div className="budgetrow" key={s.payee}>
                  <div className="budgetrow-top">
                    <CategoryIcon category={s.category} className="tile sm" />
                    <span className="nm">{s.payee}</span>
                    <span className="num">{s.exact ? `₹${money(s.amount)}` : 'varies'}</span>
                  </div>
                  <div className="budgetrow-foot">
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {s.count} times, last on {dayLabel(s.last)}
                    </span>
                    <span className="danger-actions" style={{ gap: 8 }}>
                      <button className="linkish" disabled={busy} onClick={() => pin(s)}>
                        Pin it
                      </button>
                      <button
                        className="linkish quiet"
                        disabled={busy}
                        onClick={() => run(() => saveTemplate({ ...templateFromSuggestion(s), pinned: false, hidden: true }))}
                      >
                        Not this
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 2px 0', lineHeight: 1.6 }}>
            Worked out from your own rows — four or more of the same payment in the last sixty
            days. These already show as tiles on Today; pinning one keeps it there even when
            the habit tails off, and &ldquo;Not this&rdquo; takes it away for good.
          </p>
        </>
      )}

      {/* ── Dismissed ───────────────────────────────────────────────────── */}
      {view.dismissed.length > 0 && (
        <>
          <h2 className="section">Dismissed</h2>
          <div className="card">
            <ul className="ledger">
              {view.dismissed.map((t) => (
                <li key={t.id}>
                  <div className="row">
                    <span className="who">
                      <span className="name">{t.label}</span>
                      <span className="meta">Never suggested again</span>
                    </span>
                    <button className="linkish" disabled={busy} onClick={() => restore(t)}>
                      Bring back
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <button
        className="btn ghost"
        style={{ marginTop: 14 }}
        disabled={!supported}
        onClick={() => setEditing(blankRepeat())}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add a repeat
      </button>

      <p className="muted" style={{ fontSize: 12, marginTop: 18, lineHeight: 1.6 }}>
        Nothing here posts on its own. A bill that comes due appears on Today and waits for
        you to confirm it — the ledger only ever holds payments you said happened.
      </p>

      {/* An occurrence of a bill with no agreed amount. The form writes the
          payment; stamping the bill afterwards is what stops it being offered
          again. Mounted only while open, same as everywhere else. */}
      {posting && (
        <ManualEntry
          open
          title={`${posting.t.label} — ${dayLabel(posting.on)}`}
          seed={seedFromTemplate(posting.t, { on: posting.on })}
          onClose={() => setPosting(null)}
          onSaved={() => {
            const { t, on } = posting
            setPosting(null)
            run(() => stamp(t, on))
          }}
        />
      )}

      {editing && (
        <RepeatSheet
          initial={editing}
          busy={busy}
          confirming={confirming === editing.id}
          onConfirm={() => setConfirming(editing.id)}
          onCancelConfirm={() => setConfirming(null)}
          onDelete={() => drop(editing.id)}
          onClose={() => {
            setEditing(null)
            setConfirming(null)
          }}
          onSave={save}
        />
      )}
    </div>
  )
}

/** One repeat. Mounted only while open, so it always starts on the values it
 *  was handed — same contract as EditSheet and BudgetSheet. */
function RepeatSheet({ initial, busy, confirming, onConfirm, onCancelConfirm, onDelete, onClose, onSave }) {
  const [d, setD] = useState(initial)
  const [err, setErr] = useState('')
  const [showing, setShowing] = useState(true)

  const set = (k, v) => setD((p) => ({ ...p, [k]: v }))

  const finish = () => {
    setShowing(false)
    setTimeout(onClose, EXIT)
  }

  function submit(e) {
    e.preventDefault()
    if (!d.payee.trim()) return setErr('Who it is paid to is needed.')
    if (d.amount !== '' && !(Number(d.amount) > 0)) return setErr('That amount is not usable.')
    if (d.unit !== 'none' && d.until && d.until < d.starts_on) return setErr('It cannot end before it starts.')
    onSave({ ...d, label: (d.label.trim() || d.payee.trim()).slice(0, 40) })
  }

  const scheduled = d.unit !== 'none'
  const preview = scheduled ? describeRule(ruleOf(d)) : null

  return (
    <Sheet open={showing} onClose={finish} title={d.id ? 'Edit repeat' : 'Add a repeat'}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Paid to</span>
          <input
            type="text"
            required
            autoFocus
            maxLength={120}
            value={d.payee}
            onChange={(e) => set('payee', e.target.value)}
            placeholder="Landlord, Netflix, the chai stall…"
          />
        </label>

        <label className="field">
          <span>Called</span>
          <input
            type="text"
            maxLength={40}
            value={d.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder={d.payee.trim() || 'Rent'}
          />
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: '-10px 0 16px' }}>
          What the tile says. Short enough to fit four across a phone.
        </p>

        <label className="field">
          <span>Amount</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            className="num"
            value={d.amount}
            onChange={(e) => set('amount', e.target.value)}
            placeholder="Leave empty to be asked each time"
          />
        </label>

        <CategoryPicker value={d.category} onChange={(v) => set('category', v)} />

        {/* ── The schedule ──────────────────────────────────────────────── */}
        <Select
          label="Repeats"
          value={d.unit}
          options={UNIT_OPTIONS}
          onChange={(v) => set('unit', v)}
          hint="Leave it on Never for something you tap yourself rather than something that comes round."
        />

        {scheduled && (
          <>
            {(() => {
              const every = (
                <label className="field">
                  <span>Every</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="366"
                    className="num"
                    value={d.every}
                    onChange={(e) => set('every', e.target.value)}
                  />
                </label>
              )
              // "Every 3 days" needs no second control, so it does not get half
              // a row and an empty box beside it.
              if (d.unit === 'day') return every
              return (
                <div className="pair">
                  {every}
                  {d.unit === 'week' ? (
                    <Select
                      label="On"
                      value={d.weekday}
                      options={WEEKDAYS.map(([value, label]) => ({ value, label }))}
                      onChange={(v) => set('weekday', v)}
                    />
                  ) : (
                    <Select
                      label="On the"
                      value={d.monthDay}
                      options={MONTH_DAYS}
                      onChange={(v) => set('monthDay', v)}
                      hint="A date past the end of a short month lands on its last day, and goes back to the date it wants the moment there is one."
                    />
                  )}
                </div>
              )
            })()}

            <div className="pair">
              <DateField label="Starts on" value={d.starts_on} onChange={(v) => set('starts_on', v)} />
              <label className="field">
                <span>Ends (optional)</span>
                <input type="date" value={d.until} onChange={(e) => set('until', e.target.value)} />
              </label>
            </div>

            {preview && (
              <p className="muted" style={{ fontSize: 13, margin: '-6px 0 16px' }}>
                {preview}, from {dayLabel(d.starts_on)}.
              </p>
            )}
          </>
        )}

        {/* ── The details, same as any other payment ────────────────────── */}
        <div className="pair">
          <Select
            label="Type"
            value={d.type}
            options={TYPE_OPTIONS}
            onChange={(v) => set('type', v)}
          />
          <Select
            label="Direction"
            value={d.direction}
            options={DIRECTIONS}
            onChange={(v) => set('direction', v)}
          />
        </div>

        {!COUNTED.has(d.type) && (
          <p className="warn" style={{ fontSize: 12.5, margin: '-10px 0 16px' }}>
            A {d.type} is your own money moving — rows from this will be in no total on any screen.
          </p>
        )}

        <label className="field">
          <span>Note</span>
          <input
            type="text"
            maxLength={140}
            value={d.note}
            onChange={(e) => set('note', e.target.value)}
            placeholder="Goes on every row this writes"
          />
        </label>

        {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>

        {d.id && (
          <div className="danger">
            {confirming ? (
              <>
                <p className="muted">
                  Delete this repeat? Payments it already wrote stay in your ledger.
                </p>
                <div className="danger-actions">
                  <button type="button" className="btn ghost small" onClick={onCancelConfirm}>
                    Keep it
                  </button>
                  <button type="button" className="btn small destructive" disabled={busy} onClick={onDelete}>
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="linkish danger-link" onClick={onConfirm}>
                Delete this repeat
              </button>
            )}
          </div>
        )}
      </form>
    </Sheet>
  )
}
