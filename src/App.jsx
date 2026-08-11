import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { supabase, configured } from './lib/supabase'
import { countNeedsReview } from './lib/db'
import { loadMerchantMap, clearMapCache } from './lib/categorise'
import SignIn from './screens/SignIn.jsx'
import Today from './screens/Today.jsx'
import Ledger from './screens/Ledger.jsx'

// Charts and the once-a-week screens are dead weight on the daily path.
const Insights = lazy(() => import('./screens/Insights.jsx'))
const Review = lazy(() => import('./screens/Review.jsx'))
const Teach = lazy(() => import('./screens/Teach.jsx'))
const Import = lazy(() => import('./screens/Import.jsx'))
const Ask = lazy(() => import('./screens/Ask.jsx'))
const Budgets = lazy(() => import('./screens/Budgets.jsx'))
const Merchants = lazy(() => import('./screens/Merchants.jsx'))

const TABS = [
  ['today', 'Today'],
  ['ledger', 'Ledger'],
  ['insights', 'Insights'],
  ['more', 'More'],
]

const SUB = ['review', 'teach', 'import', 'ask', 'budgets', 'merchants']

/**
 * Suspense cannot catch a rejected import, only a pending one. The service
 * worker registers with `autoUpdate` and skipWaiting, so a deploy claims an
 * already-open tab and purges the old precache: the next tap on a lazy screen
 * asks for a chunk that no longer exists, the promise rejects, and the whole
 * tree unmounts to a blank page. A reload always fixes it, and the user has no
 * way to know that — so offer the reload.
 */
class ScreenBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('[screen]', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="screen">
        <h1 className="title">That screen didn’t load</h1>
        <div className="card">
          <p className="empty">
            The app updated while it was open. Reloading picks up the new version — nothing you
            logged is affected.
          </p>
        </div>
        <p style={{ textAlign: 'center', marginTop: 18 }}>
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      </div>
    )
  }
}

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = still checking
  const [tab, setTab] = useState('today')
  const [reviewCount, setReviewCount] = useState(0)

  useEffect(() => {
    if (!configured) return setSession(null)
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      clearMapCache()
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Every screen is a history entry, so the Android back gesture and the
  // browser back button do the obvious thing instead of closing the app from
  // three levels deep.
  //
  // The ref, not the state, is what `go` compares against: pushState inside a
  // setState updater fires twice under StrictMode, which stacks two entries per
  // navigation and makes one Back press look like it did nothing.
  const current = useRef('today')

  useEffect(() => {
    history.replaceState({ tab: 'today' }, '')
    const onPop = (e) => {
      const next = e.state?.tab ?? 'today'
      current.current = next
      setTab(next)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback((next) => {
    if (next === current.current) return
    current.current = next
    history.pushState({ tab: next }, '')
    setTab(next)
  }, [])

  const back = useCallback(() => history.back(), [])

  const refreshCounts = useCallback(() => {
    countNeedsReview().then(setReviewCount).catch(() => {})
  }, [])

  useEffect(() => {
    if (!session) return
    loadMerchantMap(true).catch(() => {})
    refreshCounts()
  }, [session, refreshCounts])

  if (session === undefined) return <div className="screen" />
  // Inside .app so the sign-in column matches the rest of the app on a desktop
  // window instead of stretching the full width.
  if (!session) return <div className="app" style={{ paddingBottom: 0 }}><SignIn /></div>

  return (
    <div className="app">
      <ScreenBoundary key={tab}>
      <Suspense fallback={<div className="screen" />}>
        {tab === 'today' && (
          <Today onChange={refreshCounts} reviewCount={reviewCount} goReview={() => go('review')} />
        )}
        {tab === 'ledger' && <Ledger onChange={refreshCounts} />}
        {tab === 'insights' && <Insights goAsk={() => go('ask')} />}
        {tab === 'ask' && <Ask onBack={back} />}
        {tab === 'budgets' && <Budgets onBack={back} />}
        {tab === 'merchants' && <Merchants onBack={back} onChange={refreshCounts} />}
        {tab === 'review' && <Review onChange={refreshCounts} onBack={back} />}
        {tab === 'teach' && <Teach onChange={refreshCounts} onBack={back} />}
        {tab === 'import' && <Import onChange={refreshCounts} onBack={back} />}
        {tab === 'more' && <More go={go} email={session.user?.email} reviewCount={reviewCount} />}
      </Suspense>
      </ScreenBoundary>

      <nav className="nav">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id || (id === 'more' && SUB.includes(tab))}
            onClick={() => go(id)}
          >
            {label}
            {id === 'more' && reviewCount > 0 && <span className="badge">{reviewCount}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}

// Light is the design; dark is the same tokens for anyone who logs at 1am with
// the lights off. Applied to <html> so the CSS is a single attribute swap.
function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('theme', dark ? 'dark' : 'light')
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121511' : '#F1F1ED')
  }, [dark])

  // A .stat baseline-aligns its children, which left the 28px switch sitting
  // below the label. Its own row, centre-aligned, with the label as the target.
  return (
    <div className="panel switchrow">
      <label htmlFor="theme-switch">
        <span className="k">Dark</span>
        <span className="sub">Same palette, for logging at 1am</span>
      </label>
      <button
        id="theme-switch"
        role="switch"
        aria-checked={dark}
        aria-label="Dark appearance"
        className="switch"
        onClick={() => setDark((d) => !d)}
      >
        <i />
      </button>
    </div>
  )
}

const MENU = [
  ['ask', 'Ask', 'A question about your money, answered on this device'],
  ['budgets', 'Budgets', 'A number to spend against, not just one spent'],
  ['review', 'Needs a look', 'Rows the parser wasn’t sure about'],
  ['teach', 'Teach me', 'Name the merchants it doesn’t know yet'],
  ['merchants', 'What it has learned', 'See and correct every merchant it can name'],
  ['import', 'Import a statement', 'Catch the days screenshots missed'],
]

/**
 * Signing out has to take the shared-screenshot cache with it. The service
 * worker parks shared images there under a fixed key, and a share that was
 * written but never consumed would otherwise survive into the next person's
 * session on the same device — their ledger, someone else's screenshots.
 */
async function signOut() {
  try {
    await caches?.delete('hisaab-shared')
  } catch {
    // No Cache API, or storage refused. Signing out still has to happen.
  }
  await supabase.auth.signOut()
}

function More({ go, email, reviewCount }) {
  return (
    <div className="screen">
      <h1 className="title">More</h1>

      <div className="card">
        <ul className="ledger">
          {MENU.map(([id, label, sub]) => (
            <li key={id}>
              <button className="row menurow" onClick={() => go(id)}>
                <span className="who">
                  <span className="name">{label}</span>
                  <span className="meta">{sub}</span>
                </span>
                {id === 'review' && reviewCount > 0 && <span className="badge solo">{reviewCount}</span>}
                <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <h2 className="section">Appearance</h2>
      <ThemeToggle />

      <h2 className="section">Account</h2>
      <div className="panel">
        <div className="stat">
          <span className="k">Signed in</span>
          <span className="v" style={{ fontSize: 14 }}>{email}</span>
        </div>
        <div className="stat">
          <span className="k">Session</span>
          <button className="linkish" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
        Screenshots are read on this device and discarded. Only the parsed row —
        date, amount, merchant, category — is stored, plus the raw text of rows
        flagged for review, which is cleared once you’ve looked at them. Unknown
        merchant names are the single thing sent to an AI, without amounts or dates.
      </p>
    </div>
  )
}
