import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readBatch, preload } from '../lib/ocr'
import { parseScreenshot } from '../lib/parse'
import { categoriseBatch, persistAILearnings, learn } from '../lib/categorise'
import {
  saveTransactions, listTransactions, updateTransaction, deleteTransaction, listBudgets,
  listTemplates, postTemplate, TOTAL_BUDGET,
} from '../lib/db'
import {
  money, iso, today, dayLabel, timeLabel, spendTotal, startOfMonth, daysInMonth, endOfMonth,
} from '../lib/format'
import { TYPE_OPTIONS } from '../lib/categories'
import { findFrequent, FREQUENT_WINDOW } from '../lib/recurring'
import { committedBetween, isDue, pendingOccurrences } from '../lib/schedule'
import { seedFromRow, seedFromTemplate, templateFromSuggestion } from '../lib/entry'
import CategoryIcon from '../components/CategoryIcon.jsx'
import CategoryPicker from '../components/CategoryPicker.jsx'
import Select from '../components/Select.jsx'
import EditSheet from '../components/EditSheet.jsx'
import Amount from '../components/Amount.jsx'
import ManualEntry from '../components/ManualEntry.jsx'
import NotifyPrompt from '../components/NotifyPrompt.jsx'
import { HeroSkeleton, RowsSkeleton, Bar } from '../components/Skeleton.jsx'
import { takeSharedFiles } from '../lib/share'

// Home. One sentence about the week, one number for today, one place to drop a
// screenshot. Everything after the drop is automatic — the app only speaks when
// it's genuinely unsure. BUILD_GUIDE.md §6.6.

const HEADER = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return iso(d)
}

const Rs = ({ n }) => (
  <span className="num">
    <span className="rupee">₹</span>
    {money(n)}
  </span>
)

/** Two weeks of spend turned into one sentence. No API call — the comparison is
 *  arithmetic, and a narrative the app can't back with numbers is just noise. */
function narrate(week, prev) {
  if (week === 0) return { lede: 'Nothing logged in the last seven days.', tail: null }
  if (prev === 0) return { lede: null, tail: 'First week on the ledger.' }
  const pct = Math.round(((week - prev) / prev) * 100)
  if (Math.abs(pct) < 8) return { lede: null, tail: 'Roughly the same as the week before.' }
  return { lede: null, tail: `${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'} the week before.` }
}

/** The most tiles Today will ever show. Four fit across a 320px phone, and a
 *  wall of one-tap buttons that each write a payment is not a quick way to log
 *  — it is a quick way to log the wrong thing. */
const MAX_TILES = 4

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

export default function Today({ onChange, reviewCount, goReview, goRepeats }) {
  const fileRef = useRef(null)
  // A ref, not state: `ingest` closes over the state it was created with, so a
  // second batch arriving mid-read would read a stale `false` and start anyway.
  const reading = useRef(false)
  const [rows, setRows] = useState([]) // last 14 days, for the week sentence
  // [] is both "still fetching" and "genuinely nothing", and the screen was
  // showing the second — "You've spent ₹0 this week", "Nothing logged today" —
  // while the first was still true.
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(null) // { done, total, stage }
  const [nudge, setNudge] = useState('') // said once, while the read is running
  const [result, setResult] = useState(null)
  const [pending, setPending] = useState(null) // categorised rows whose save failed
  const [shared, setShared] = useState(null) // files off the share sheet, awaiting a tap
  // The seed the add form opens on, or null for closed. 'blank' is its own
  // value rather than an empty seed: a seed means "these exact values", so
  // handing the form a blank one would overwrite the rail and pocket it is
  // supposed to reopen on with two empty strings.
  const [entry, setEntry] = useState(null)
  const [over, setOver] = useState(false)
  const [budget, setBudget] = useState(null) // { limit, spent } for the month
  const [templates, setTemplates] = useState([])
  const [tapping, setTapping] = useState(null) // the tile mid-write
  const [undo, setUndo] = useState(null) // { id, label } — the last one-tap log

  const load = useCallback(async () => {
    // Sixty days, because that is the window the tile suggestions are read over
    // (lib/recurring.js). The week sentence and the month budget are both
    // filtered out of the same rows, so widening it costs one query rather than
    // three — and a fortnight was never enough to tell a habit from a one-off.
    const from = [daysAgo(FREQUENT_WINDOW - 1), startOfMonth()].sort()[0]
    const r = await listTransactions({ from, to: today(), limit: 2000 })
    setRows(r)
    setLoaded(true)
    return r
  }, [])

  // Fails quiet and to []. A database that has never run
  // db/migrate-templates.sql has no repeats, which is not an error and must not
  // take down the one screen the app is for.
  const loadTemplates = useCallback(
    () => listTemplates().then(setTemplates).catch(() => setTemplates([])),
    [],
  )

  useEffect(() => {
    // Even a failed load stops the placeholders: the screen is still usable —
    // you can drop a screenshot into it — and a skeleton that never resolves is
    // worse than a real zero.
    load().catch(() => setLoaded(true))
    loadTemplates()
    listBudgets()
      .then((b) => setBudget(b.find((x) => x.category === TOTAL_BUDGET) ?? null))
      .catch(() => {})
    // Warm Tesseract while the user is reading the screen, not after they tap.
    const id = setTimeout(preload, 400)
    return () => clearTimeout(id)
  }, [load, loadTemplates])

  // The save is the last step and the only one that needs the network, so a
  // failure here costs a minute of OCR that was already correct. The rows stay
  // in `pending` until one lands and the user can retry. Component state only,
  // deliberately — they're gone on reload, which is an honest promise, where a
  // queue that quietly drains hours later is not.
  const save = useCallback(
    async (categorised) => {
      const saved = await saveTransactions(categorised)
      persistAILearnings(categorised).catch(() => {}) // never block on this

      setPending(null)
      setResult(saved)
      await load()
      onChange?.()
    },
    [load, onChange],
  )

  const ingest = useCallback(
    async (files) => {
      if (files.length === 0) return
      // Two batches share one Tesseract worker and one progress bar: the second
      // rewinds the bar, and the first to finish clears the indicator out from
      // under the one still running. Paste fires even while the drop zone is
      // swapped out for the progress card, so this is the only place to stop it.
      if (reading.current) {
        setNudge('Still reading the last batch — that one was skipped.')
        return
      }
      reading.current = true
      setNudge('')
      setResult(null)
      setPending(null)
      setBusy({ done: 0, total: files.length, stage: 'reading' })
      try {
        const texts = await readBatch(files, (done, total) =>
          setBusy({ done, total, stage: 'reading' }),
        )
        setBusy({ done: files.length, total: files.length, stage: 'sorting' })

        // One history screenshot carries ~7 transactions, a receipt carries one.
        // Dated against when the shot was taken, not when it was dropped here:
        // "Paid Today" on a Tuesday screenshot means Tuesday however long it
        // sat in the gallery. See takenAt() in lib/ocr.js.
        const parsed = texts.flatMap((t) => parseScreenshot(t.text, t.when))

        const categorised = await categoriseBatch(parsed)
        setPending(categorised) // held from here on; a save that lands clears it
        await save(categorised)
      } catch (err) {
        setResult({ error: err.message ?? String(err) })
      } finally {
        reading.current = false
        setBusy(null)
      }
    },
    [save],
  )

  // Same flag: saveTransactions dedupes against rows already in the table, but
  // two of them in flight together would both find nothing and both insert.
  async function retrySave() {
    if (reading.current) return
    reading.current = true
    setResult(null)
    try {
      await save(pending)
    } catch (err) {
      setResult({ error: err.message ?? String(err) })
    } finally {
      reading.current = false
    }
  }

  function handleFiles(e) {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // let the same files be picked again
    ingest(files)
  }

  // Opened from Android's share sheet: the screenshots are already waiting.
  // Parked, never ingested on arrival. The service worker takes any cross-origin
  // POST to /share-target, so an automatic import lets a hostile page forge rows
  // into a signed-in ledger without a gesture — and a cache entry left unread
  // would land on whoever opens the app next on a shared phone. Nothing is read
  // until the tap. No-op on every normal cold start.
  useEffect(() => {
    takeSharedFiles()
      .then((files) => files.length > 0 && setShared(files))
      .catch(() => {})
  }, [])

  // Paste is the fastest path on desktop: screenshot, Ctrl+V, done. No button.
  useEffect(() => {
    function onPaste(e) {
      const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (imgs.length > 0) ingest(imgs)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [ingest])

  function onDrop(e) {
    e.preventDefault()
    setOver(false)
    ingest([...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/')))
  }

  const d = useMemo(() => {
    const t = today()
    const weekFrom = daysAgo(6)
    const prevFrom = daysAgo(13)
    const todays = rows.filter((r) => r.txn_date === t)
    const week = spendTotal(rows.filter((r) => r.txn_date >= weekFrom))
    const prev = spendTotal(rows.filter((r) => r.txn_date >= prevFrom && r.txn_date < weekFrom))
    const month = spendTotal(rows.filter((r) => r.txn_date >= startOfMonth()))
    const now = new Date()
    return {
      todays,
      todayTotal: spendTotal(todays),
      week,
      prev,
      month,
      daysLeft: daysInMonth(now) - now.getDate(),
      ...narrate(week, prev),
    }
  }, [rows])

  /**
   * The one-tap tiles.
   *
   * Two sources, in that order: what you pinned, then what the ledger suggests.
   * A suggestion is not a stored row and never becomes one by being shown — it
   * is four-plus identical payments in sixty days, recomputed every load, and
   * it leaves on its own when the habit does.
   *
   * A payee already named by a template drops out of the suggestions whatever
   * that template says, which is what makes "don't offer me this" work: the
   * dismissal is a hidden row carrying the name.
   */
  const tiles = useMemo(() => {
    const pinned = templates.filter((t) => t.pinned && !t.rule && !t.hidden)
    const known = templates.map((t) => t.payee)
    const suggested = findFrequent(rows)
      .filter((s) => !known.some((name) => sameName(name, s.payee)))
      .map((s) => ({ ...templateFromSuggestion(s), id: null }))
    return [...pinned, ...suggested].slice(0, MAX_TILES)
  }, [templates, rows])

  /**
   * Bills due today or overdue. Nothing posts itself — this is a list of things
   * to confirm, which is the whole difference between a reminder and an app that
   * invents transactions.
   *
   * Every pending date, not one per bill: a rent nobody has confirmed since June
   * is three payments to deal with, and the strip's total said one. The Repeats
   * screen has always listed them date by date, so the two disagreed about the
   * same bills.
   */
  const dueBills = useMemo(
    () =>
      templates
        .filter((t) => t.rule && !t.hidden && isDue(t))
        .map((t) => ({ t, dates: pendingOccurrences(t) })),
    [templates],
  )

  const dueTotal = dueBills.reduce((s, { t, dates }) => s + (Number(t.amount) || 0) * dates.length, 0)

  /**
   * What the rest of this month is already spoken for. Counted off the same
   * templates the tiles and the due strip read, so it costs no query.
   *
   * Windowed to this month. Without the `from`, arrears from earlier months
   * landed in a figure labelled "this month" and were then subtracted from what
   * is left of it — see committedBetween. The overdue ones are named in the
   * strip above rather than folded into the number.
   */
  const committed = useMemo(
    () => committedBetween(templates, endOfMonth(), { from: startOfMonth() }),
    [templates],
  )

  async function tapTile(t) {
    // No agreed amount — the grocery run. Everything else is filled in and the
    // form opens on the number, which is still most of the typing saved.
    if (t.amount == null) return setEntry(seedFromTemplate(t))

    setTapping(t.id ?? t.payee)
    setUndo(null)
    try {
      const result = await postTemplate(t)
      const logged = result.rows?.[0]
      // A duplicate here means the clock stamp collided inside one second,
      // which is a double-tap rather than a second chai. Nothing to undo.
      if (logged) setUndo({ id: logged.id, label: `${t.label} ₹${money(t.amount)}` })
      await load()
      onChange?.()
    } catch (e) {
      setResult({ error: e.message ?? String(e) })
    } finally {
      setTapping(null)
    }
  }

  /** One tap wrote a payment, so one tap has to be able to take it back. */
  async function undoLast() {
    if (!undo) return
    const { id } = undo
    setUndo(null)
    try {
      await deleteTransaction(id)
      await load()
      onChange?.()
    } catch (e) {
      setResult({ error: e.message ?? String(e) })
    }
  }

  return (
    <div className="screen">
      {/* Outside .stagger — a display:none child would still claim a slot in
          the reveal sequence and a gap in the rhythm. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden-file"
        onChange={handleFiles}
      />

      <div className="stagger">
        <p className="eyebrow">{HEADER.format(new Date())}</p>

        {loaded ? (
          <h1 className="lede">
            {d.lede ?? (
              <>
                You&rsquo;ve spent <Rs n={d.week} /> this week.{' '}
                {d.tail && <span className="dim">{d.tail}</span>}
              </>
            )}
          </h1>
        ) : (
          <h1 className="lede" aria-label="Loading your week">
            <Bar w="92%" h={22} />
            <Bar w="58%" h={22} style={{ marginTop: 9 }} />
          </h1>
        )}

        {loaded ? (
          <div className="brand">
            {/* "logged", not "spent" — ₹0 means nothing was entered, which is not
                the same claim as having spent nothing. */}
            <p className="caption">Logged today</p>
            <Amount value={d.todayTotal} className="amount" />
            <hr />
            <div className="foot">
              <div>
                <span className="k">Last 7 days</span>
                <b className="num">₹{money(d.week)}</b>
              </div>
              <div>
                <span className="k">Daily average</span>
                <b className="num">₹{money(d.week / 7)}</b>
              </div>
            </div>
          </div>
        ) : (
          <HeroSkeleton />
        )}

        {/* Shown for a budget, for commitments, or for both. Either half alone
            is still worth a line: a budget with no bills is what the app has
            always shown, and bills with no budget still answer "what is left of
            this month" better than nothing does. */}
        {(budget || committed.total > 0 || committed.unknown > 0) && (
          <MonthLine
            limit={budget ? Number(budget.amount) : null}
            spent={d.month}
            daysLeft={d.daysLeft}
            committed={committed}
          />
        )}

        {/* Renders nothing once it has been answered, or where the browser has
            already decided. */}
        <NotifyPrompt />

        {dueBills.length > 0 && (
          <button type="button" className="duebills" onClick={goRepeats}>
            <span className="who">
              <span className="name">
                {dueBills.length} repeat{dueBills.length === 1 ? '' : 's'} due
              </span>
              <span className="meta">
                {dueBills.slice(0, 3).map(({ t }) => t.label).join(' · ')}
                {dueBills.length > 3 && ` and ${dueBills.length - 3} more`}
              </span>
            </span>
            <span className="amt num">₹{money(dueTotal)}</span>
          </button>
        )}

        {tiles.length > 0 && (
          <div className="quicktiles" role="group" aria-label="Log something you buy often">
            {tiles.map((t) => (
              <button
                key={t.id ?? t.payee}
                type="button"
                className="tile-add"
                disabled={tapping != null}
                aria-busy={tapping === (t.id ?? t.payee)}
                onClick={() => tapTile(t)}
              >
                <span className="nm">{t.label}</span>
                <span className="num">
                  {t.amount == null ? 'Amount…' : `₹${money(t.amount)}`}
                </span>
              </button>
            ))}
          </div>
        )}

        {undo && (
          <p className="undoline" role="status">
            Logged {undo.label}.{' '}
            <button type="button" className="linkish" onClick={undoLast}>
              Undo
            </button>
          </p>
        )}

        {shared && (
          <SharedFiles
            files={shared}
            onImport={() => {
              setShared(null)
              ingest(shared)
            }}
            onDiscard={() => setShared(null)}
          />
        )}

        {busy ? (
          <div className="drop">
            <div className="headline">
              {busy.stage === 'reading' ? `Reading ${busy.done} of ${busy.total}` : 'Sorting'}…
            </div>
            <div className="sub">Screenshots are read on this device.</div>
            <div className="progress">
              <i style={{ width: `${(busy.done / busy.total) * 100}%` }} />
            </div>
            {/* Lives inside the progress card, so it clears itself when the read
                ends rather than needing a timer. */}
            {nudge && (
              <div className="sub" role="status">
                {nudge}
              </div>
            )}
          </div>
        ) : (
          // A button, not the old <label>: the input is display:none, which takes
          // it out of the tab order, and a label is not a tab stop either — so the
          // one thing the app is for could not be reached without a pointer. The
          // input still does the actual picking.
          <button
            type="button"
            className={`drop${over ? ' over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div className="headline">Drop a screenshot.</div>
            <div className="sub">
              I&rsquo;ll handle the rest — or tap to pick, or press{' '}
              <span className="kbd">Ctrl</span> <span className="kbd">V</span>
            </div>
          </button>
        )}

        {result && (
          <Found
            result={result}
            reviewCount={reviewCount}
            goReview={goReview}
            onRetry={pending ? retrySave : null}
          />
        )}
      </div>

      {!result && reviewCount > 0 && (
        <p style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="linkish" onClick={goReview}>
            {reviewCount} need{reviewCount === 1 ? 's' : ''} a look
          </button>
        </p>
      )}

      {/* "Add a payment", not "Add a cash payment". The form does every rail,
          every account and every type now — the old wording was describing the
          limitation rather than the feature. */}
      <p style={{ textAlign: 'center', marginTop: 16 }}>
        <button className="linkish quiet" onClick={() => setEntry('blank')}>
          Add a payment
        </button>
      </p>

      {/* Mounted only while open, so every entry starts on the values it was
          handed. ManualEntry holds the sheet down through its own exit before
          either callback fires — same contract as EditSheet. */}
      {entry && (
        <ManualEntry
          open
          seed={entry === 'blank' ? null : entry}
          onClose={() => setEntry(null)}
          onSaved={async () => {
            setEntry(null)
            await load()
            loadTemplates()
            onChange?.()
          }}
        />
      )}

      <h2 className="section">{dayLabel(today())}</h2>
      {!loaded ? (
        <RowsSkeleton rows={2} />
      ) : d.todays.length === 0 ? (
        <div className="card">
          <p className="empty">Nothing logged today.</p>
        </div>
      ) : (
        <div className="card">
          <ul className="ledger">
            {d.todays.map((r) => (
              <Row key={r.id} r={r} onChange={async () => { await load(); onChange?.() }} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The only line on this screen that is about the future rather than the past.
 *
 * Two halves, either of which can be missing. The budget half is the bar and
 * what is left of the month's limit. The committed half is what the repeats
 * already claim of the days remaining — which is the difference between
 * "₹40,000 left" and knowing that ₹28,649 of it is rent and the SIP.
 *
 * The per-day figure divides by the days remaining *including today*, because
 * today is a day you can still spend on. It is the number people actually act
 * on: nobody plans against ₹11,351, everybody understands ₹630.
 *
 * Everything here is about the month it names. Bills left unconfirmed from
 * earlier months are counted by `committed.overdue` and not by `committed.total`
 * — they are somebody else's month, and the strip above lists them by name.
 *
 * No bar without a limit — an empty progress bar is worse than no bar.
 */
function MonthLine({ limit, spent, daysLeft, committed }) {
  const left = limit == null ? null : limit - spent
  const over = left != null && left < 0
  // Bills with no agreed amount are counted, never guessed at. Left out of the
  // total silently, the line would read as certainty it has not got.
  const unsure = committed.unknown > 0
    ? ` · ${committed.unknown} more with no set amount`
    : ''

  // No budget: the commitments are the whole line, and there is nothing to
  // measure them against without inventing a figure.
  if (left == null) {
    return (
      <div className="budgetline">
        <div className="budgetline-top">
          <span>
            <b className="num">₹{money(committed.total)}</b> committed this month
          </span>
          <span className="muted num">
            {daysLeft} day{daysLeft === 1 ? '' : 's'} to go
          </span>
        </div>
        {unsure && <p className="budgetline-foot muted">{committed.unknown} more with no set amount.</p>}
      </div>
    )
  }

  const pct = Math.min(100, (spent / limit) * 100)
  const free = left - committed.total
  const perDay = free / (daysLeft + 1)

  return (
    <div className="budgetline">
      <div className="budgetline-top">
        <span>
          <b className="num">₹{money(Math.abs(left))}</b> {over ? 'over budget' : 'left this month'}
        </span>
        <span className="muted num">
          {daysLeft} day{daysLeft === 1 ? '' : 's'} to go
        </span>
      </div>
      <div className="budgetbar">
        <i style={{ width: `${pct}%`, background: over ? 'var(--negative)' : 'var(--forest-green)' }} />
      </div>
      {committed.total > 0 && !over && (
        <p className="budgetline-foot muted">
          <span className="num">₹{money(committed.total)}</span> of that is committed
          {free < 0 ? (
            <> — <span className="num">₹{money(-free)}</span> more than is left</>
          ) : (
            <> — <b className="num">₹{money(perDay)}</b> a day free</>
          )}
          {unsure}
        </p>
      )}
      {/* Over budget already, and still owing: the per-day figure would be a
          negative number dressed up as an allowance. */}
      {committed.total > 0 && over && (
        <p className="budgetline-foot muted">
          <span className="num">₹{money(committed.total)}</span> more is committed before the month is out
          {unsure}
        </p>
      )}
      {committed.total === 0 && unsure && (
        <p className="budgetline-foot muted">{committed.unknown} bill{committed.unknown === 1 ? '' : 's'} due with no set amount.</p>
      )}
    </div>
  )
}

/** The gate on a share. Whatever arrived is named and counted, and it stays a
 *  file on disk until this is tapped — a share is a request, not an instruction. */
function SharedFiles({ files, onImport, onDiscard }) {
  const n = files.length
  return (
    <div className="found">
      <div className="head">
        <div className="title">
          {n} screenshot{n === 1 ? '' : 's'} shared
        </div>
        <p className="sub">Nothing is read or added to your ledger until you say so.</p>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 16px 16px' }}>
        <button type="button" className="btn small" onClick={onImport}>
          Import {n} screenshot{n === 1 ? '' : 's'}
        </button>
        <button type="button" className="btn ghost small" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  )
}

/** What the read actually produced, itemised. A count alone asks the user to go
 *  and check; the rows themselves are the receipt. */
function Found({ result, reviewCount, goReview, onRetry }) {
  if (result.error) {
    return (
      <div style={{ marginTop: 16 }}>
        <p className="alert" style={{ fontSize: 14, margin: 0 }}>
          Couldn&rsquo;t save: {result.error}
        </p>
        {/* The reading and the sorting both worked — only the network didn't.
            Retrying the save beats reading the screenshots a second time. */}
        {onRetry && (
          <button type="button" className="btn ghost small" style={{ marginTop: 10 }} onClick={onRetry}>
            Retry save
          </button>
        )}
      </div>
    )
  }

  const found = result.rows ?? []
  const notes = []
  if (result.duplicates) notes.push(`${result.duplicates} already logged`)
  if (result.unusable) notes.push(`${result.unusable} not a payment`)

  if (found.length === 0) {
    return (
      <p className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 14 }}>
        {notes.length > 0 ? `Nothing new — ${notes.join(', ')}.` : 'Nothing readable in that.'}
      </p>
    )
  }

  return (
    <div className="found">
      <div className="head">
        <div className="title">
          I found {found.length} transaction{found.length === 1 ? '' : 's'}
        </div>
        <p className="sub">
          Saved{notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}
          {reviewCount > 0 && (
            <>
              {' · '}
              <button className="linkish" onClick={goReview}>
                {reviewCount} need{reviewCount === 1 ? 's' : ''} a look
              </button>
            </>
          )}
        </p>
      </div>
      <ul className="ledger">
        {found.slice(0, 6).map((r) => (
          <li key={r.id}>
            <div className="row">
              <CategoryIcon category={r.category} />
              <span className="who">
                <span className="name">{r.payee_clean || r.payee_raw}</span>
                <span className="meta">{r.category ?? 'Uncategorised'}</span>
              </span>
              <span className={`amt num ${r.direction === 'credit' ? 'in' : 'out'}`}>
                {r.direction === 'credit' ? '+' : ''}
                <span className="rupee">₹</span>
                {money(r.amount)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {found.length > 6 && (
        <p className="muted" style={{ fontSize: 12, padding: '10px 16px 12px', margin: 0 }}>
          and {found.length - 6} more.
        </p>
      )}
    </div>
  )
}

// Tap a row to fix its category on the spot — one tap, one picker, no modal.
// Everything else about the row lives behind "Edit details", so the daily
// action stays one gesture and the rare one is still reachable.
//
// In the Ledger the same row also has to be selectable, so the three selection
// props are opt-in and Today passes none of them. While `selectable` is on, the
// tap picks the row instead of opening the drawer — one gesture cannot mean two
// things, and a drawer left open under a selection is a second Edit button
// beside the bulk one.
export function Row({ r, onChange, showDate = false, selectable = false, selected = false, onToggle }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  // The add form lives on the row rather than on the screen, exactly as
  // EditSheet does. That is what makes Duplicate work in the Ledger too without
  // either screen knowing it exists.
  const [duplicating, setDuplicating] = useState(false)
  const credit = r.direction === 'credit'
  const meta = [
    showDate ? dayLabel(r.txn_date) : timeLabel(r.txn_time),
    r.category,
    r.type !== 'expense' ? r.type : null,
    r.method,
    r.note,
  ]
    .filter(Boolean)
    .join(' · ')

  // Leaving selection mode with a drawer already open would drop a picker and
  // two buttons back into a list someone is halfway through selecting.
  const expanded = open && !selectable

  return (
    <li>
      <button
        className={`row${r.needs_review ? ' flagged' : ''}${selectable ? ' picking' : ''}${selected ? ' picked' : ''}`}
        {...(selectable ? { 'aria-pressed': selected } : { 'aria-expanded': expanded })}
        onClick={() => (selectable ? onToggle?.(r.id) : setOpen((o) => !o))}
      >
        {selectable && (
          <span className="pick" data-on={selected} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          </span>
        )}
        <CategoryIcon category={r.category} />
        <span className="who">
          <span className="name">{r.payee_clean || r.payee_raw}</span>
          <span className="meta">{meta}</span>
        </span>
        <span className={`amt num ${credit ? 'in' : 'out'}`}>
          {credit ? '+' : ''}
          <span className="rupee">₹</span>
          {money(r.amount)}
        </span>
      </button>
      {/* Kept mounted so the open/close is one interruptible transition rather
          than a mount that pops. Collapsed it is 0fr tall and invisible, but a
          picker, a select and a button in there are still tab stops and still
          read aloud — thirty rows is ninety of them. `inert` takes the subtree
          out of both the tab order and the accessibility tree, so aria-hidden
          on top of it would be redundant. */}
      <div className="reveal" data-open={expanded} inert={!expanded}>
        <div>
          <QuickEdit
            r={r}
            onDone={() => { setOpen(false); onChange?.() }}
            onEdit={() => setEditing(true)}
            onDuplicate={() => setDuplicating(true)}
          />
        </div>
      </div>
      {editing && (
        <EditSheet
          row={r}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => { setOpen(false); onChange?.() }}
          onDeleted={() => { setOpen(false); onChange?.() }}
        />
      )}
      {duplicating && (
        <ManualEntry
          open
          title="Log this again"
          seed={seedFromRow(r)}
          onClose={() => setDuplicating(false)}
          onSaved={() => { setDuplicating(false); setOpen(false); onChange?.() }}
        />
      )}
    </li>
  )
}

function QuickEdit({ r, onDone, onEdit, onDuplicate }) {
  const [saving, setSaving] = useState(false)

  async function set(patch, learnIt) {
    setSaving(true)
    await updateTransaction(r.id, { ...patch, needs_review: false })
    if (learnIt) {
      await learn(r.payee_raw, { category: patch.category, payee_clean: r.payee_clean || r.payee_raw })
    }
    setSaving(false)
    onDone()
  }

  return (
    <div style={{ padding: '4px 16px 16px' }}>
      <CategoryPicker
        disabled={saving}
        value={r.category ?? ''}
        onChange={(c) => c && set({ category: c }, true)}
      />
      <Select
        label="Type"
        disabled={saving}
        value={r.type}
        options={TYPE_OPTIONS}
        onChange={(t) => set({ type: t })}
      />
      <div className="rowactions">
        <button type="button" className="btn ghost small" onClick={onEdit}>
          Edit details
        </button>
        {/* Every daily repeat there is — the same auto, the same sabzi wala —
            with no template to set up first and no guess by the app. */}
        <button type="button" className="btn ghost small" onClick={onDuplicate}>
          Log again
        </button>
      </div>
    </div>
  )
}
