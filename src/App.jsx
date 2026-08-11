import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
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

const TABS = [
  ['today', 'Today'],
  ['ledger', 'Ledger'],
  ['insights', 'Insights'],
  ['more', 'More'],
]

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

  const refreshCounts = useCallback(() => {
    countNeedsReview().then(setReviewCount).catch(() => {})
  }, [])

  useEffect(() => {
    if (!session) return
    loadMerchantMap(true).catch(() => {})
    refreshCounts()
  }, [session, refreshCounts])

  if (session === undefined) return <div className="screen" />
  if (!session) return <SignIn />

  const goReview = () => setTab('review')

  return (
    <div className="app">
      <Suspense fallback={<div className="screen" />}>
        {tab === 'today' && (
          <Today onChange={refreshCounts} reviewCount={reviewCount} goReview={goReview} />
        )}
        {tab === 'ledger' && <Ledger onChange={refreshCounts} />}
        {tab === 'insights' && <Insights />}
        {tab === 'review' && <Review onChange={refreshCounts} />}
        {tab === 'teach' && <Teach onChange={refreshCounts} />}
        {tab === 'import' && <Import onChange={refreshCounts} />}
        {tab === 'more' && <More go={setTab} email={session.user?.email} />}
      </Suspense>

      <nav className="nav">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id || (id === 'more' && ['review', 'teach', 'import'].includes(tab))}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'more' && reviewCount > 0 && <span className="badge">{reviewCount}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}

function More({ go, email }) {
  return (
    <div className="screen">
      <h1 className="title">More</h1>

      <div className="panel">
        <button className="btn ghost" onClick={() => go('review')}>
          Needs a look
        </button>
        <div style={{ height: 10 }} />
        <button className="btn ghost" onClick={() => go('teach')}>
          Teach me
        </button>
        <div style={{ height: 10 }} />
        <button className="btn ghost" onClick={() => go('import')}>
          Import a statement
        </button>
      </div>

      <h2 className="section">Account</h2>
      <div className="stat">
        <span className="k">Signed in</span>
        <span className="v" style={{ fontSize: 14 }}>{email}</span>
      </div>
      <p style={{ marginTop: 20 }}>
        <button className="linkish" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </p>

      <p className="muted" style={{ fontSize: 12, marginTop: 30, lineHeight: 1.6 }}>
        Screenshots are read on this device and discarded. Only the parsed row —
        date, amount, merchant, category — is ever stored. Unknown merchant names
        are the single thing sent to an AI, without amounts or dates.
      </p>
    </div>
  )
}
