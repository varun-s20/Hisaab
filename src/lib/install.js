// "Get the app", instead of teaching people where Chrome hides it.
//
// Installing a PWA is a first-class browser action, but every browser buries it
// somewhere different — three dots, then a menu item whose name changes between
// versions. Chromium fires `beforeinstallprompt` when the app is installable and
// lets a page hold onto that event and fire it later from a real button. That is
// the whole of this file.
//
// The listener is registered at module scope, not in a component, because the
// event fires as soon as the page is eligible — usually before React has
// mounted. A useEffect registered after that has already missed it. main.jsx
// imports this module for the side effect.

let deferred = null
const listeners = new Set()

const announce = () => listeners.forEach((fn) => fn())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Without this Chrome shows its own mini-infobar over the page, which is
    // the thing the button is meant to replace.
    e.preventDefault()
    deferred = e
    announce()
  })

  // Installed from our button or from the browser's own menu — either way the
  // offer has to disappear.
  window.addEventListener('appinstalled', () => {
    deferred = null
    announce()
  })
}

/** Already running as an installed app, so there is nothing to offer. */
export const installed = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true)

/**
 * iOS has no install prompt and no plan to add one — Safari only offers Add to
 * Home Screen from the share sheet. Detected so the button can become a
 * sentence rather than sit there dead.
 */
export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

// Shaped for useSyncExternalStore: subscribe returns its own unsubscribe, and
// canInstall is a stable boolean rather than a fresh object each read.
export const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const canInstall = () => deferred !== null

/**
 * Show the browser's install dialog. Resolves true if they went through with it.
 *
 * The event is single-use — Chrome throws on a second prompt() — so it is
 * dropped before the await rather than after, which also hides the button while
 * the dialog is open instead of leaving a second tap armed behind it.
 */
export async function promptInstall() {
  const e = deferred
  if (!e) return false
  deferred = null
  announce()
  try {
    e.prompt()
    const { outcome } = await e.userChoice
    return outcome === 'accepted'
  } catch {
    // Dismissed in a way the browser calls an error. Nothing to recover.
    return false
  }
}
