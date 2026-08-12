import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Bottom sheet. Transitions rather than keyframes, so opening one while another
// is closing retargets instead of restarting. Exit runs at ~65% of enter — slow
// where the user is deciding, fast where the system is responding.

export const EXIT = 180

// Tab has to stay inside a modal. Without this it walks straight out to the
// ledger rows behind the scrim, with nothing on screen saying where it went.
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Sheets nest — the category picker opens its own sheet from inside the edit
// sheet — so the body lock is counted rather than toggled. Each sheet putting
// back whatever it found had the inner one hand the outer one's 'hidden' back
// to the page, which then stayed unscrollable for the rest of the session.
let locks = 0
let unlocked = ''

// One id per opened sheet, so a popstate can tell whose entry just left.
let seq = 0

export default function Sheet({ open, onClose, title, children }) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panel = useRef(null)
  // The history entry this sheet owns while it is open, 0 once it is gone.
  const entry = useRef(0)
  // onClose is a fresh arrow at every call site, so it cannot be an effect
  // dependency: the effects below would tear down the scroll lock and the
  // history entry and rebuild them on every render of the parent.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Back, not onClose. The sheet's entry has to leave the stack with the
  // sheet, so every deliberate close goes through the same pop the hardware
  // Back button makes, and the popstate handler below does the real closing.
  // Balance rule: one push per open, one pop, whoever asks for it.
  const close = useCallback(() => {
    if (entry.current) history.back()
    else closeRef.current()
  }, [])

  useEffect(() => {
    if (open) {
      setMounted(true)
      // One frame at the closed position, or there is nothing to transition from.
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), EXIT)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!mounted) return
    // Nested sheets both hear this — only the one holding the top entry, which
    // is the one the user can actually see, should answer.
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (entry.current && history.state?.sheet !== entry.current) return
      close()
    }
    window.addEventListener('keydown', onKey)
    // Locking the page stops the sheet's own list from scrolling the ledger
    // behind it once it hits its end.
    if (locks++ === 0) {
      unlocked = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    // Whatever opened the sheet is where the user was standing; put them back.
    const from = document.activeElement
    return () => {
      window.removeEventListener('keydown', onKey)
      if (--locks === 0) document.body.style.overflow = unlocked
      from?.focus?.()
    }
  }, [mounted, close])

  // Android has no Escape key, so the hardware Back button is the close
  // gesture — without an entry of its own the sheet lets Back close the app.
  // Keyed on `open`, not on `mounted`: reopening inside the exit window has to
  // push again, and closing has to give the entry back before the exit ends.
  useEffect(() => {
    if (!open) {
      // Closed without going through Back — a category was picked, a row was
      // saved — so the entry is still on top and has to come off.
      if (entry.current) {
        entry.current = 0
        history.back()
      }
      return
    }
    // Guarded by the ref, not by the effect running: StrictMode mounts effects
    // twice and a second push would leave an entry nobody ever pops.
    if (!entry.current) {
      entry.current = ++seq
      // Carrying the current state along keeps App's tab readable if this
      // entry is ever landed on going forward.
      history.pushState({ ...history.state, sheet: entry.current }, '')
    }
  }, [open])

  useEffect(() => {
    if (!mounted) return
    const onPop = () => {
      // Already gave the entry up, so this pop is App changing tabs — not ours
      // to swallow. Still sitting on our own entry means something was pushed
      // above it and that is what left; also not ours.
      if (!entry.current || history.state?.sheet === entry.current) return
      entry.current = 0
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [mounted])

  useEffect(() => {
    if (shown) panel.current?.focus()
  }, [shown])

  function trap(e) {
    if (e.key !== 'Tab') return
    // A nested sheet renders inside this panel, so the innermost trap has to
    // be the only one that acts — otherwise both move the focus.
    e.stopPropagation()
    const items = panel.current?.querySelectorAll(FOCUSABLE)
    if (!items?.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const on = document.activeElement
    if (e.shiftKey && (on === first || on === panel.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && on === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!mounted) return null

  // Portalled to <body>, because a sheet is rendered from wherever it is opened
  // and that is often inside a <form>: ManualEntry, EditSheet and the budget
  // sheet all open the category picker from inside theirs, which put a <form>
  // inside a <form>. Invalid HTML, and Chrome says so.
  //
  // It also means the sheet is no longer a descendant of .screen, so nothing an
  // ancestor does — a transform, an opacity animation, a stacking context —
  // can move a position:fixed scrim out from under it.
  //
  // React events still bubble through the React tree, not the DOM one, so a
  // submit inside a portalled form would still reach an outer form's onSubmit.
  // Nothing nested is a <form> any more (see CategoryPicker), which is what
  // actually settles that half.
  return createPortal(
    <div className="sheet-root" data-open={shown}>
      <button className="sheet-scrim" aria-label="Close" onClick={close} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onKeyDown={trap}
      >
        <div className="sheet-grip" />
        <div className="sheet-head">
          <span>{title}</span>
          <button className="sheet-x" onClick={close} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
