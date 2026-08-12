import { useState } from 'react'
import { iso, today } from '../lib/format'
import Sheet from './Sheet.jsx'

// The app's own calendar. `<input type="date">` hands the one screen you look
// at every day over to the OS: a blue system dialog on Android, a wheel on iOS,
// a tiny grey icon on desktop. None of it is this app, and on a phone the
// native picker is also the slowest way there is to say "yesterday".
//
// Week starts Monday, same as everywhere else in Hisaab (lib/query.js).

const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' })
const FULL = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const parse = (s) => {
  if (!s) return null
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  return dt.getDate() === d && dt.getMonth() === m - 1 ? dt : null
}

/** Monday-first offset for a month's 1st. */
const leading = (y, m) => (new Date(y, m, 1).getDay() + 6) % 7

const shortLabel = (value) => {
  const d = parse(value)
  if (!d) return null
  const t = today()
  if (value === t) return 'Today'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  if (value === iso(y)) return 'Yesterday'
  return FULL.format(d)
}

export default function DateField({
  label = 'Date',
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a date',
  disabled,
}) {
  const [open, setOpen] = useState(false)
  // Which month the grid is showing. Seeded from the value each time it opens,
  // so reopening on a row dated in March does not start you in this month.
  const [view, setView] = useState(() => parse(value) ?? new Date())

  function reopen() {
    setView(parse(value) ?? new Date())
    setOpen(true)
  }

  const y = view.getFullYear()
  const m = view.getMonth()
  const days = new Date(y, m + 1, 0).getDate()
  const pad = leading(y, m)
  const blocked = (d) => (min && d < min) || (max && d > max)

  // Whole months, so a picker capped at today doesn't offer next month at all.
  const prevOk = !min || iso(new Date(y, m, 1)) > min
  const nextOk = !max || iso(new Date(y, m + 1, 1)) <= max

  const pick = (d) => {
    onChange(d)
    setOpen(false)
  }

  return (
    <>
      <div className="field">
        {label && <span>{label}</span>}
        <button type="button" className="picker bare" disabled={disabled} onClick={reopen}>
          <svg className="picker-cal" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.6" />
            <path d="M3.4 9.8h17.2M8.4 3.4v3.6M15.6 3.4v3.6" />
          </svg>
          <span className={`picker-label${value ? '' : ' muted'}`}>
            {shortLabel(value) ?? placeholder}
          </span>
          <svg className="picker-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <div className="cal">
          <div className="cal-head">
            <button
              type="button"
              className="iconbtn"
              aria-label="Previous month"
              disabled={!prevOk}
              onClick={() => setView(new Date(y, m - 1, 1))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="cal-month">{MONTH_YEAR.format(view)}</span>
            <button
              type="button"
              className="iconbtn"
              aria-label="Next month"
              disabled={!nextOk}
              onClick={() => setView(new Date(y, m + 1, 1))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>

          <div className="cal-grid" role="grid">
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="cal-wd" aria-hidden="true">
                {w}
              </span>
            ))}
            {Array.from({ length: pad }, (_, i) => (
              <span key={`p${i}`} />
            ))}
            {Array.from({ length: days }, (_, i) => {
              const d = iso(new Date(y, m, i + 1))
              return (
                <button
                  key={d}
                  type="button"
                  className="cal-day"
                  disabled={blocked(d)}
                  data-selected={d === value}
                  data-today={d === today()}
                  aria-label={FULL.format(new Date(y, m, i + 1))}
                  onClick={() => pick(d)}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>

          {/* The two answers people actually give, one tap from anywhere in the
              calendar rather than three taps back to this month. */}
          <div className="cal-quick">
            {[
              ['Today', today()],
              [
                'Yesterday',
                (() => {
                  const d = new Date()
                  d.setDate(d.getDate() - 1)
                  return iso(d)
                })(),
              ],
            ].map(([name, d]) => (
              <button
                key={name}
                type="button"
                className="btn ghost small"
                disabled={blocked(d)}
                onClick={() => pick(d)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </Sheet>
    </>
  )
}
