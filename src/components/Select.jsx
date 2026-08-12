import { useState } from 'react'
import Sheet from './Sheet.jsx'

// The app's own dropdown. A native <select> renders as OS chrome — a grey
// system list on Android, a spinning wheel on iOS — which is the one control on
// every form that visibly isn't part of this app. Same trigger as the category
// picker, same sheet, so every choice in Hisaab is made the same way.
//
// options: ['expense', 'income'] or [{ value, label, sub }]

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
}) {
  const [open, setOpen] = useState(false)
  const list = options.map(norm)
  const current = list.find((o) => o.value === value)

  const trigger = (
    <button
      type="button"
      className={`picker bare${compact ? ' compact' : ''}`}
      disabled={disabled}
      onClick={() => setOpen(true)}
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
      </Sheet>
    </>
  )
}
