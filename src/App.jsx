import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { supabase, configured } from './lib/supabase'
import { countNeedsReview, countUntaught, listTransactions, listBudgets, TOTAL_BUDGET } from './lib/db'
import { loadMerchantMap, clearMapCache } from './lib/categorise'
import { today } from './lib/format'
import * as notify from './lib/notify'
import Nav, { TABS, SUB } from './components/Nav.jsx'
import Select from './components/Select.jsx'
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
const Accounts = lazy(() => import('./screens/Accounts.jsx'))

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
  // "Teach me" had no count anywhere, so the only way to discover work was
  // waiting there was to open the screen and look.
  const [untaughtCount, setUntaughtCount] = useState(0)

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
    countUntaught().then(setUntaughtCount).catch(() => {})
  }, [])

  useEffect(() => {
    if (!session) return
    loadMerchantMap(true).catch(() => {})
    refreshCounts()
  }, [session, refreshCounts])

  // Reminders. The facts live here because the worker cannot reach the
  // database — a nudge to log the day is worth sending only on a day with
  // nothing on it. See lib/notify.js.
  const counts = useRef({ reviewCount: 0, untaughtCount: 0 })
  counts.current = { reviewCount, untaughtCount }

  useEffect(() => {
    if (!session) return
    // Re-read rather than cached for the session: the evening nudge asks "log
    // today" and the app can easily be open from morning to night, so a fact
    // read at 9am would nag someone who logged at noon. Nine minutes, against a
    // watcher that ticks every ten — one one-row query per tick.
    const cache = { at: 0, hasBudget: true, loggedToday: true }
    const getFacts = async () => {
      if (Date.now() - cache.at > 9 * 60 * 1000) {
        const [rows, budgets] = await Promise.all([
          listTransactions({ from: today(), to: today(), limit: 1 }).catch(() => []),
          listBudgets().catch(() => null),
        ])
        cache.at = Date.now()
        cache.loggedToday = rows.length > 0
        // null means the read failed — keep the last answer rather than
        // claiming there is no budget and firing the 1st-of-month reminder at
        // someone who set one.
        if (budgets) cache.hasBudget = budgets.some((b) => b.category === TOTAL_BUDGET)
      }
      return { ...cache, ...counts.current }
    }

    return notify.watch(getFacts)
  }, [session])

  // A tapped reminder lands on the screen it was about.
  useEffect(() => {
    const open = new URLSearchParams(location.search).get('open')
    if (open && (TABS.some(([id]) => id === open) || SUB.includes(open))) {
      current.current = open
      setTab(open)
      history.replaceState({ tab: open }, '', location.pathname)
    }
    const onMessage = (e) => {
      const next = e.data?.type === 'hisaab-open' ? e.data.tab : null
      if (!next) return
      current.current = next
      setTab(next)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

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
        {tab === 'accounts' && <Accounts onBack={back} />}
        {tab === 'merchants' && <Merchants onBack={back} onChange={refreshCounts} />}
        {tab === 'review' && <Review onChange={refreshCounts} onBack={back} />}
        {tab === 'teach' && <Teach onChange={refreshCounts} onBack={back} />}
        {tab === 'import' && <Import onChange={refreshCounts} onBack={back} />}
        {tab === 'more' && (
          <More
            go={go}
            email={session.user?.email}
            reviewCount={reviewCount}
            untaughtCount={untaughtCount}
          />
        )}
      </Suspense>
      </ScreenBoundary>

      <Nav tab={tab} go={go} badge={reviewCount + untaughtCount} />
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

/**
 * Reminders, off by default. Permission is asked on the tap and nowhere else —
 * a prompt on first load is how a site gets blocked forever.
 */
function Reminders() {
  const [prefs, setPrefs] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    notify.readPrefs().then(setPrefs)
  }, [])

  if (!prefs) return <div className="panel" style={{ minHeight: 78 }} />

  if (!notify.supported()) {
    return (
      <div className="panel">
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          This browser can&rsquo;t show reminders. Install the app from Chrome on Android
          and they&rsquo;ll arrive even when it&rsquo;s closed.
        </p>
      </div>
    )
  }

  const on = prefs.enabled && Notification.permission === 'granted'

  async function toggle() {
    setErr('')
    try {
      if (on) {
        await notify.disable()
      } else {
        await notify.enable()
      }
      setPrefs(await notify.readPrefs())
    } catch (e) {
      setErr(e.message ?? String(e))
    }
  }

  async function set(patch) {
    setPrefs(await notify.writePrefs(patch))
  }

  return (
    <>
      <div className="panel switchrow">
        <label htmlFor="notify-switch">
          <span className="k">Remind me</span>
          <span className="sub">The 1st to budget, once a day to log, Sunday if anything is waiting</span>
        </label>
        <button
          id="notify-switch"
          role="switch"
          aria-checked={on}
          aria-label="Reminders"
          className="switch"
          onClick={toggle}
        >
          <i />
        </button>
      </div>

      {prefs.enabled && Notification.permission !== 'granted' && (
        <p className="muted" style={{ fontSize: 12.5, margin: '8px 2px 0', lineHeight: 1.6 }}>
          {Notification.permission === 'denied'
            ? 'Reminders are on, but this site is blocked from showing notifications. Allow them in the browser’s site settings.'
            : 'Reminders are on. Tap the switch to let the browser show them.'}
        </p>
      )}

      {on && (
        <div className="panel" style={{ marginTop: 10 }}>
          {/* Every hour. "Evening" was my assumption, not yours — someone who
              logs on the commute wants 8am and someone who logs in bed wants
              1am, and neither was on the list. */}
          <Select
            label="Daily nudge, from"
            value={prefs.dailyHour}
            onChange={(h) => set({ dailyHour: h })}
            options={Array.from({ length: 24 }, (_, h) => ({
              value: h,
              label: `${h % 12 === 0 ? 12 : h % 12}:00 ${h >= 12 ? 'pm' : 'am'}`,
            }))}
          />
          <p className="muted" style={{ fontSize: 12, margin: '12px 0 0', lineHeight: 1.6 }}>
            Skipped on a day you&rsquo;ve already logged something. Nothing about your money
            leaves the device — these are written and scheduled here.
          </p>
        </div>
      )}

      {err && <p className="alert" style={{ fontSize: 13 }}>{err}</p>}
    </>
  )
}

const MENU = [
  ['ask', 'Ask', 'A question about your money, answered on this device'],
  ['budgets', 'Budgets', 'A number to spend against, not just one spent'],
  ['accounts', 'Accounts', 'What is left in each card, bank and envelope'],
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

function More({ go, email, reviewCount, untaughtCount }) {
  const badges = { review: reviewCount, teach: untaughtCount }
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
                {badges[id] > 0 && <span className="badge solo">{badges[id]}</span>}
                <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <h2 className="section">Reminders</h2>
      <Reminders />

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

      {/* This paragraph is a promise, so it has to be the whole truth rather
          than the flattering half. It used to say merchant names were "the
          single thing sent to an AI", which stopped being true the day Ask
          started sending your category and payment-method names — and stopped
          again when it started sending your account names. What never goes is
          still the part that matters, so say both. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
        Screenshots are read on this device and discarded. Only the parsed row —
        date, amount, merchant, category — is stored, plus the raw text of rows
        flagged for review, which is cleared once you’ve looked at them.
      </p>
      <p className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
        Two things reach an AI, both names only. Categorising sends merchant names it
        doesn’t recognise — never one that looks like a person. Ask sends your question
        along with the names of your categories, payment methods and accounts, and gets
        back a filter that runs here. No amount, no date, and no transaction of yours is
        ever sent.
      </p>
    </div>
  )
}
