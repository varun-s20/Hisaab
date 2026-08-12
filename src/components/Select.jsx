import { useState } from 'react'
import Sheet from './Sheet.jsx'

// The app's own dropdown. A native <select> renders as OS chrome — a grey
// system list on Android, a spinning wheel on iOS — which is the one control on
// every form that visibly isn't part of this app. Same trigger as the category
// picker, same sheet, so every choice in Hisaab is made the same way.
//
// options: ['expense', 'income'] or [{ value, label, sub }]
//
// `allowNew` turns a closed list into an open one — the sheet grows a "New …"
// field and whatever is typed becomes the value. Accounts need it and types do
// not: nobody invents an eighth kind of transaction, but everybody has their
// own cards, banks and envelopes. Off by default, so every existing Select is
// exactly as closed as it was.

const norm = (o) => (typeof o === 'string' ? { value: o, label: o } : o)

export default function Select({
  label,
  value,
  onChange,
  options,
  placeholder = 'Pick one',
  hint,
  disabled,
  compact = false,
  allowNew = false,
  newLabel = 'New',
  newPlaceholder = '',
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const list = options.map(norm)
  // The row's own value, even when it is not in the list — an account typed on
  // another device, or one whose only other row was just deleted. Without this
  // the trigger falls back to the placeholder and the sheet shows no tick, so a
  // value that is really set reads as "Not recorded".
  if (value && !list.some((o) => o.value === value)) list.push({ value, label: value })
  const current = list.find((o) => o.value === value)

  function openSheet() {
    setAdding(false)
    setDraft('')
    setOpen(true)
  }

  function create() {
    const clean = draft.trim().slice(0, 40)
    if (!clean) return
    onChange(clean)
    setOpen(false)
  }

  const trigger = (
    <button
      type="button"
      className={`picker bare${compact ? ' compact' : ''}`}
      disabled={disabled}
      onClick={openSheet}
    >
      <span className={`picker-label${current ? '' : ' muted'}`}>{current?.label ?? placeholder}</span>
      <svg className="picker-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  )

  return (
    <>
      {compact ? (
        trigger
      ) : (
        <div className="field">
          {label && <span>{label}</span>}
          {trigger}
        </div>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title={label ?? 'Choose'}>
        {hint && <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>{hint}</p>}
        <div className="catgrid">
          {list.map((o) => (
            <div className="catcell" key={o.value}>
              <button
                type="button"
                className="catrow bare"
                data-selected={o.value === value}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span className="opt">
                  <span className="nm">{o.label}</span>
                  {o.sub && <span className="sub">{o.sub}</span>}
                </span>
                {o.value === value && (
                  <svg className="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>

        {allowNew &&
          (adding ? (
            // A <div>, not a <form>, and for the reason CategoryPicker spells
            // out: this sheet opens from inside EditSheet's form, and a nested
            // submit bubbles to the outer handler — so Enter here would save
            // the whole row instead of adding the account.
            <div className="newcat">
              <label className="field">
                <span>{newLabel}</span>
                <input
                  type="text"
                  autoFocus
                  maxLength={40}
                  value={draft}
                  placeholder={newPlaceholder}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    create()
                  }}
                />
              </label>
              <div className="newcat-actions">
                <button type="button" className="btn ghost small" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button type="button" className="btn small" disabled={!draft.trim()} onClick={create}>
                  {newLabel}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn ghost" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {newLabel}
            </button>
          ))}
      </Sheet>
    </>
  )
}
