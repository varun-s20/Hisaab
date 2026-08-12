import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// sw.js is built with skipWaiting(), so a new deploy seizes control of this tab
// while it is still running the previous bundle — and by then the old lazy
// chunks App.jsx imports are gone from the precache, so the next screen the
// user opens 404s. Reloading fixes that, but only while the app is hidden:
// yanking the page out from under someone mid-entry loses what they typed.
//
// The visible-branch update() matters just as much. An installed PWA is usually
// resumed rather than relaunched, so it never navigates, so nothing ever
// re-fetches sw.js on its own — without this an installed user can sit on a
// stale build indefinitely.
if ('serviceWorker' in navigator) {
  let stale = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    stale = true
    if (document.hidden) location.reload()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (stale) location.reload()
    } else {
      navigator.serviceWorker.getRegistration().then((r) => r?.update())
    }
  })
}
