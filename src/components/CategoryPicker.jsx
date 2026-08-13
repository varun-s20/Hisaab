import { useState } from 'react'
import { allCategories, addCategory, removeCategory, isCustom, PICKABLE_COLORS } from '../lib/categories'
import CategoryIcon, { ICON_NAMES, Glyph } from './CategoryIcon.jsx'
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
  const [icon, setIcon] = useState(ICON_NAMES[0])
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

  const [saving, setSaving] = useState(false)

  // Async since categories became rows rather than a device preference. The
  // error path matters more than it used to: a failed write now means the
  // category does not exist anywhere, and the sheet has to say so instead of
  // closing as though it worked.
  async function create() {
    setSaving(true)
    try {
      const created = await addCategory(name, colour, icon)
      setList(allCategories())
      pick(created)
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setSaving(false)
    }
  }

  // Two steps, inline, the same as EditSheet. Removing a category is silent
  // everywhere else in the app: it leaves every picker at once and the rows
  // already filed under it quietly count as Other from then on.
  async function drop(c) {
    try {
      await removeCategory(c)
      if (value === c) onChange('')
    } catch (e2) {
      setErr(e2.message)
    }
    setList(allCategories())
    setDropping('')
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
          {/* `blank`, not `empty`: `.empty` is the global empty-state rule and
              carries `padding: 40px 0`, which the placeholder tile inherited —
              that is the entire reason this control stood two inches taller
              than every input beside it. */}
          <span className="tile sm blank" />
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
                  {/* .catrow, not a bare <button>: `.catcell > button` styled
                      *every* direct child button, which included the remove
                      control below — it inherited width:100% and grid columns,
                      so the ✕ was stretched across the whole row and drawn over
                      the icon. Tapping the row you wanted to select hit remove
                      instead, which is why a category you had made could never
                      be picked a second time. */}
                  <button
                    type="button"
                    className="catrow"
                    data-selected={c === value}
                    data-removable={isCustom(c)}
                    onClick={() => pick(c)}
                  >
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
          // A <div>, not a <form>. This sheet is opened from inside the forms
          // in ManualEntry, EditSheet and Budgets, so a form here nested one
          // inside another — and a nested submit does not just warn, it bubbles
          // to the outer handler: adding a category from the cash-payment sheet
          // was firing ManualEntry's save. Enter still works, below.
          <div className="newcat">
            {/* The one honest answer to "did that colour take?" — the thing
                being made, drawn as it will appear in every row. A 2px ring on
                a swatch is not an answer you can see on a phone. */}
            <div className="newcat-preview">
              <CategoryIcon icon={icon} color={colour} />
              <span className="nm">{name.trim() || 'New category'}</span>
            </div>

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
                // What the <form> was doing for us. Kept on the input rather
                // than the container so Enter in the name field adds it and
                // Enter anywhere else does nothing surprising.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (name.trim() && !saving) create()
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
                  aria-pressed={c === colour}
                  data-selected={c === colour}
                  style={{ background: c }}
                  onClick={() => setColour(c)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                </button>
              ))}
            </div>

            <span className="field-label" style={{ marginTop: 16 }}>Icon</span>
            <div className="iconpick">
              {ICON_NAMES.map((n) => (
                <button
                  type="button"
                  key={n}
                  aria-label={`Icon ${n.replace(/-/g, ' ')}`}
                  aria-pressed={n === icon}
                  data-selected={n === icon}
                  onClick={() => setIcon(n)}
                >
                  <Glyph icon={n} />
                </button>
              ))}
            </div>

            {err && <p className="alert" style={{ fontSize: 14, margin: '10px 0 0' }}>{err}</p>}
            <div className="newcat-actions">
              <button type="button" className="btn ghost small" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn small"
                disabled={!name.trim() || saving}
                onClick={create}
              >
                {saving ? 'Saving…' : 'Add category'}
              </button>
            </div>
          </div>
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
