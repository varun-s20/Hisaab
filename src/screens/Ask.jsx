import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listTransactions, listMethods, listAccounts } from '../lib/db'
import { money, dayLabel, spendTotal, earnTotal, investTotal } from '../lib/format'
import { askForFilter } from '../lib/ai'
import { allCategories, colorFor } from '../lib/categories'
import { sanitise, guess, applySpec, group, describe, uncategorisedNote } from '../lib/query'
import ScreenHeader from '../components/ScreenHeader.jsx'
import Amount from '../components/Amount.jsx'
import { Bar, HeroSkeleton, RowsSkeleton } from '../components/Skeleton.jsx'
import { Row } from './Today.jsx'

// "What did I spend on food last month?" — the one place a second model call
// earns its cost, and the one place the privacy rule needed real design rather
// than a guard comment.
//
// The question, the category names, the payment methods and today's date go to
// the API. A *filter* comes back. Every field of it is snapped to something the
// app already knows (lib/query.js), and then it runs here, against rows that
// never left the phone. No amount, no merchant, no date of anything you paid is
// ever sent. If the model is unreachable the question is parsed locally instead,
// badly but usefully — Ask is not a dead screen offline.

const EXAMPLES = [
  'How much did I spend on food last month?',
  'Which app did I pay with most this month?',
  // The account axis is invisible until something names it — nobody guesses a
  // dimension a screen has never shown them.
  'Which account did it come out of?',
  'Biggest transactions this year',
  'What did I spend at Swiggy?',
  'Money received last 30 days',
]

/** The most rows one answer is computed over. A question with no period in it
 *  is "all time", which on a long ledger is more than this — so the figure has
 *  to be able to say it is reading a window rather than everything. */
const READ_LIMIT = 5000

const GROUP_TITLE = {
  category: 'By category',
  merchant: 'By merchant',
  method: 'By payment method',
  account: 'By account',
  day: 'By day',
}

export default function Ask({ onBack }) {
  const [q, setQ] = useState('')
  const [methods, setMethods] = useState([])
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { spec, rows, local }
  const [err, setErr] = useState('')
  const input = useRef(null)

  useEffect(() => {
    listMethods().then(setMethods).catch(() => {})
    listAccounts().then(setAccounts).catch(() => {})
    input.current?.focus()
  }, [])

  const run = useCallback(
    async (question) => {
      const text = question.trim()
      if (!text || busy) return
      setBusy(true)
      setErr('')
      setResult(null)

      let local = false
      // Hisaab's quota, or the user's own Gemini key if they set one. Same
      // prompt either way (shared/gemini.js), and either way what leaves is the
      // question plus names — never a transaction.
      //
      // Guarded, and it was not: every ordinary failure inside askForFilter
      // returns null, but reading the session can genuinely throw — and the only
      // setBusy(false) was in the finally of the block below, so a throw here
      // left the spinner turning for good with no error line and nothing to
      // press. An unreachable assistant is exactly what the local reader is for.
      let raw = null
      try {
        raw = await askForFilter({
          question: text,
          today: new Date().toLocaleDateString('en-CA'), // local YYYY-MM-DD, not UTC
          categories: allCategories(),
          methods,
          accounts,
        })
      } catch {
        // Left null: the fallback below is the answer.
      }
      let spec = raw ? sanitise(raw, { methods, accounts }) : null

      if (!spec) {
        // Guarded: the local reader is the fallback, so a throw here would
        // leave the screen spinning with nothing left to fall back to.
        try {
          spec = guess(text, { methods, accounts })
        } catch {
          spec = sanitise({}, { methods, accounts })
        }
        local = true
      }

      try {
        // Only the validated date window reaches the database. Everything else
        // is applied in memory, so a malformed spec can never become a query.
        const rows = await listTransactions({ from: spec.from, to: spec.to, limit: READ_LIMIT })
        // Computed here, against the rows before the category filter took them
        // away — that count no longer exists once applySpec has run.
        setResult({
          spec,
          rows: applySpec(rows, spec),
          local,
          note: uncategorisedNote(spec, rows),
          // Newest-first, so hitting the ceiling drops the OLDEST rows in the
          // window and the total comes back confident and short. Said out loud
          // rather than left as a number nobody can check — this is the one
          // screen that answers a question with a single figure.
          truncated: rows.length >= READ_LIMIT,
        })
      } catch (e) {
        setErr(e.message ?? String(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, methods, accounts],
  )

  /** Re-read after a row was edited. Re-applies the spec that produced what is
   *  on screen — running the input box again would answer a half-typed question
   *  the user never asked — and leaves the old list mounted while it loads, so
   *  the row under the thumb does not vanish mid-tap. */
  const refresh = useCallback(async () => {
    if (!result) return
    const { spec, local } = result
    try {
      const rows = await listTransactions({ from: spec.from, to: spec.to, limit: READ_LIMIT })
      setResult({
        spec,
        rows: applySpec(rows, spec),
        local,
        note: uncategorisedNote(spec, rows),
        truncated: rows.length >= READ_LIMIT,
      })
    } catch (e) {
      setErr(e.message ?? String(e))
    }
  }, [result])

  const view = useMemo(() => {
    if (!result) return null
    const { rows, spec } = result
    // Spending and money received are never added together anywhere else in the
    // app, and they must not be here either: "show all my transactions last
    // month" legitimately produces types: [], and a flat sum over ₹30,000 spent
    // plus a ₹50,000 salary rendered ₹80,000 in the largest type on the screen.
    const out = spendTotal(rows)
    const inn = earnTotal(rows)
    const put = investTotal(rows)
    const mixed = [out, inn, put].filter((n) => n > 0).length > 1
    // Whichever single kind the answer is about. A question that matched only
    // transfers has no total in any of the three — say the row count instead of
    // printing a confident ₹0 over rows that plainly exist.
    const total = out || inn || put
    const groups = group(rows, spec.groupBy)
    const max = Math.max(1, ...groups.map((g) => g.total))
    const sorted =
      spec.sort === 'amount'
        ? [...rows].sort((a, b) => Number(b.amount) - Number(a.amount))
        : rows
    return { total, out, inn, put, mixed, groups, max, sorted }
  }, [result])

  return (
    <div className="screen">
      <ScreenHeader title="Ask" onBack={onBack} />

      <form
        className="askbar"
        onSubmit={(e) => {
          e.preventDefault()
          run(q)
        }}
      >
        <input
          ref={input}
          type="text"
          value={q}
          maxLength={300}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about your money…"
          aria-label="Ask about your money"
        />
        <button className="asksend" disabled={busy || !q.trim()} aria-label="Ask">
          {busy ? (
            <span className="spinner" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h13M12 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </form>

      {!result && !busy && (
        <>
          {/* "Only the question goes out" was never quite true — the category
              and method names went with it, and now the account names do too.
              The promise worth making is the one that is actually kept, and it
              is the stronger one anyway: no transaction of yours is ever sent. */}
          <p className="muted" style={{ fontSize: 13, margin: '2px 0 12px' }}>
            Your question and the names of your categories, methods and accounts go out. No
            transaction does — a filter comes back and runs here, on this device.
          </p>
          <div className="examples">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                onClick={() => {
                  setQ(e)
                  run(e)
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Two round trips — the model, then the ledger — behind a spinner the
          size of a stamp. Draw the answer that is coming instead. */}
      {busy && (
        <div role="status" aria-label="Working it out">
          <Bar w="64%" h={12} style={{ margin: '2px 0 10px' }} />
          <HeroSkeleton />
          <RowsSkeleton rows={3} head />
        </div>
      )}

      {err && <p className="alert" style={{ fontSize: 14 }}>{err}</p>}

      {result && view && (
        <div className="stagger">
          <p className="eyebrow" style={{ margin: 0 }}>
            {result.spec.answer || 'Here’s what matches.'}
          </p>

          <div className="brand">
            <p className="caption">
              {result.rows.length} transaction{result.rows.length === 1 ? '' : 's'}
            </p>
            <Amount value={view.total} className="amount" />
            <hr />
            <div className="foot">
              {view.mixed && view.inn > 0 && (
                <div>
                  <span className="k">Money in</span>
                  <b className="num" style={{ fontSize: 13, fontWeight: 600 }}>₹{money(view.inn)}</b>
                </div>
              )}
              {view.mixed && view.put > 0 && (
                <div>
                  <span className="k">Invested</span>
                  <b className="num" style={{ fontSize: 13, fontWeight: 600 }}>₹{money(view.put)}</b>
                </div>
              )}
              <div>
                <span className="k">Filter used</span>
                <b style={{ fontSize: 13, fontWeight: 600 }}>{describe(result.spec)}</b>
              </div>
            </div>
          </div>

          {result.local && (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              Read on this device — the assistant was unreachable, so this is a rough match.
            </p>
          )}

          {result.truncated && (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              Read over your most recent {READ_LIMIT.toLocaleString('en-IN')} transactions, which
              is as far back as one answer goes. Anything older than that is not in this figure —
              name a month or a year to ask about it.
            </p>
          )}

          {/* A ₹0 over a list of real rows is the app looking broken. It isn't:
              transfers and money lent are in no total by design, and saying so
              is cheaper than making the reader work it out. */}
          {view.total === 0 && result.rows.length > 0 && (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
              These are transfers — your own money moving between accounts, so they add
              to no total. Change a row&rsquo;s type if one of them was really a payment.
            </p>
          )}

          {/* A category question over an unfiled ledger. Said on every such
              answer, not only the empty one: a small confident figure that
              silently omits most of the payments is the worse of the two. */}
          {result.note && result.rows.length > 0 && (
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{result.note}</p>
          )}

          {result.rows.length === 0 && (
            <div className="card">
              <p className="empty">
                {result.note ?? 'Nothing matched. Try naming a category or a period.'}
              </p>
            </div>
          )}

          {view.groups.length > 0 && (
            <div className="card">
              <div className="card-head">
                <span>{GROUP_TITLE[result.spec.groupBy]}</span>
                <span>{view.groups.length}</span>
              </div>
              <div className="card-body" style={{ paddingTop: 4 }}>
                {view.groups.slice(0, 12).map((g) => (
                  <div className="grouprow" key={g.key}>
                    <div className="grouprow-top">
                      <span className="nm">
                        {result.spec.groupBy === 'day' ? dayLabel(g.key) : g.key}
                      </span>
                      <span className="num vl">₹{money(g.total)}</span>
                    </div>
                    <div className="groupbar">
                      <i
                        style={{
                          width: `${(g.total / view.max) * 100}%`,
                          background:
                            result.spec.groupBy === 'category' ? colorFor(g.key) : 'var(--bright-green)',
                        }}
                      />
                    </div>
                    <span className="ct">
                      {g.count} transaction{g.count === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view.sorted.length > 0 && (
            <div className="card">
              <div className="card-head">
                <span>{result.spec.sort === 'amount' ? 'Largest first' : 'Most recent first'}</span>
                <span>{view.sorted.length > 50 ? 'top 50' : view.sorted.length}</span>
              </div>
              <ul className="ledger">
                {view.sorted.slice(0, 50).map((r) => (
                  <Row key={r.id} r={r} showDate onChange={refresh} />
                ))}
              </ul>
            </div>
          )}

          <p style={{ textAlign: 'center', margin: 0 }}>
            <button
              className="linkish quiet"
              onClick={() => {
                setResult(null)
                setQ('')
                input.current?.focus()
              }}
            >
              Ask something else
            </button>
          </p>
        </div>
      )}

    </div>
  )
}
