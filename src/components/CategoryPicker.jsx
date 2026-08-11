import { useState } from 'react'
import { allCategories, addCategory, removeCategory, isCustom, PICKABLE_COLORS } from '../lib/categories'
import CategoryIcon from './CategoryIcon.jsx'
import Sheet from './Sheet.jsx'

// Replaces the native <select>. A dropdown of fourteen strings gives you no
// colour, no glyph, no way to add your own, and on Android it renders as a
// system list that ignores the app entirely.

export default function CategoryPicker({
  value,
  onChange,
  label = 'Category',
  placeholder = 'Pick one',
  disabled,
  compact = false, // no field wrapper, no label — for a picker sitting in a row
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [colour, setColour] = useState(PICKABLE_COLORS[0])
  const [err, setErr] = useState('')
  // The category waiting on a yes, if any.
  const [dropping, setDropping] = useState('')
  // Read once per open, not per render — localStorage in a render loop is a
  // synchronous disk hit for every row on screen.
  const [list, setList] = useState(allCategories)

  function reopen() {
    setList(allCategories())
    setAdding(false)
    setName('')
    setErr('')
    setDropping('')
    setOpen(true)
  }

  function pick(c) {
    onChange(c)
    setOpen(false)
  }

  function create(e) {
    e.preventDefault()
    try {
      const created = addCategory(name, colour)
      setList(allCategories())
      pick(created)
    } catch (e2) {
      setErr(e2.message)
    }
  }

  // Two steps, inline, the same as EditSheet. Removing a category is silent
  // everywhere else in the app: it leaves every picker at once and the rows
  // already filed under it quietly count as Other from then on.
  function drop(c) {
    removeCategory(c)
    setList(allCategories())
    setDropping('')
    if (value === c) onChange('')
  }

  const trigger = (
    <button
      type="button"
      className={`picker${compact ? ' compact' : ''}`}
      disabled={disabled}
      onClick={reopen}
    >
      {value ? (
        <>
          <CategoryIcon category={value} className="tile sm" />
          <span className="picker-label">{value}</span>
        </>
      ) : (
        <>
          <span className="tile sm empty" />
          <span className="picker-label muted">{placeholder}</span>
        </>
      )}
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

      <Sheet open={open} onClose={() => setOpen(false)} title="Category">
        <div className="catgrid">
          {list.map((c) => (
            <div className="catcell" key={c}>
              {dropping === c ? (
                <div className="confirmnote">
                  <p className="muted">
                    Remove “{c}”? Anything already filed under it counts as Other from now on.
                  </p>
                  <div className="danger-actions">
                    <button type="button" className="btn ghost small" autoFocus onClick={() => setDropping('')}>
                      Keep it
                    </button>
                    <button type="button" className="btn small destructive" onClick={() => drop(c)}>
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" data-selected={c === value} onClick={() => pick(c)}>
                    <CategoryIcon category={c} />
                    <span>{c}</span>
                    {c === value && (
                      <svg className="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    )}
                  </button>
                  {isCustom(c) && (
                    <button
                      type="button"
                      className="catdel"
                      aria-label={`Remove the ${c} category`}
                      onClick={() => setDropping(c)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        {adding ? (
          <form className="newcat" onSubmit={create}>
            <label className="field">
              <span>Name</span>
              <input
                type="text"
                autoFocus
                maxLength={28}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setErr('')
                }}
                placeholder="Pets, Gifts, Travel…"
              />
            </label>
            <span className="field-label">Colour</span>
            <div className="swatches">
              {PICKABLE_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={`Colour ${c}`}
                  data-selected={c === colour}
                  style={{ background: c }}
                  onClick={() => setColour(c)}
                />
              ))}
            </div>
            {err && <p className="alert" style={{ fontSize: 14, margin: '10px 0 0' }}>{err}</p>}
            <div className="newcat-actions">
              <button type="button" className="btn ghost small" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="btn small" disabled={!name.trim()}>
                Add category
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn ghost" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New category
          </button>
        )}
      </Sheet>
    </>
  )
}
