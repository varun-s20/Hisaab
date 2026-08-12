import { useSyncExternalStore } from 'react'
import * as install from '../lib/install'

// Renders nothing at all unless there is something to offer: already installed,
// or a browser that will never fire the prompt and isn't iOS either (desktop
// Firefox, say), and this is silent. An install button that does nothing when
// tapped is worse than no button.
//
// `heading` is for More, where the offer needs a section of its own. Deciding
// whether that heading appears has to live in here with the rest of the
// conditions, or More ends up with an empty "The app" section on every device
// the button doesn't show on.

export default function InstallButton({ label = 'Get the app', heading }) {
  const ready = useSyncExternalStore(install.subscribe, install.canInstall, () => false)

  if (install.installed()) return null

  // Safari's share sheet is the only route on iOS, and it cannot be opened from
  // a page. Saying where it is beats a button that can't work.
  const ios = !ready && install.isIOS()
  if (!ready && !ios) return null

  const content = ready ? (
    <button type="button" className="btn ghost" onClick={install.promptInstall}>
      {label}
    </button>
  ) : (
    <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
      To keep Hisaab on your home screen: tap Share, then <b>Add to Home Screen</b>.
    </p>
  )

  if (!heading) return content

  return (
    <>
      <h2 className="section">{heading}</h2>
      <div className="panel">
        {ready && (
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 14px' }}>
            Its own icon, no browser bar, and reminders that arrive while it&rsquo;s closed.
          </p>
        )}
        {content}
      </div>
    </>
  )
}
