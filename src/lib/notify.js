// Reminders, on this device, with no server.
//
// There is no push infrastructure here and deliberately so: web push needs
// VAPID keys, a subscriptions table and a cron job somewhere, which is a
// standing service to keep alive for three sentences a day. What this does
// instead:
//
//   • Periodic Background Sync fires the service worker every few hours on an
//     installed Android PWA, even with the app closed. That is the only
//     browser API that delivers a reminder without a server.
//   • Every time the app is opened or brought back to the foreground, the same
//     due-check runs in the page. So the reminder you missed is the first
//     thing you see rather than being lost.
//   • While the app is open, a timer runs the check every ten minutes, so the
//     evening nudge arrives on the evening it is for.
//
// Preferences live in a Cache entry rather than localStorage because the
// service worker has to read them too and cannot see localStorage.

const CACHE = 'hisaab-prefs'
const KEY = '/__reminders'

export const DEFAULTS = {
  // On unless turned off. Permission is still a browser prompt and still needs
  // a real tap — see armFirstGesture() — so "on" here means "you don't have to
  // go and find the switch", not "notifications appear without consent".
  enabled: true,
  dailyHour: 21, // when to ask for the day's screenshots
  daily: true,
  monthly: true, // the 1st, to set a budget
  weekly: true, // Sunday, if anything is waiting
  bills: true, // any day a repeat has come due
  shown: {}, // reminder id → the ISO date it last fired
  asked: false, // whether the permission prompt has been shown once
}

let cached = null

export async function readPrefs() {
  if (cached) return cached
  try {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(KEY)
    cached = hit ? { ...DEFAULTS, ...(await hit.json()) } : { ...DEFAULTS }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export async function writePrefs(next) {
  cached = { ...(await readPrefs()), ...next }
  try {
    const cache = await caches.open(CACHE)
    await cache.put(KEY, new Response(JSON.stringify(cached), { headers: { 'content-type': 'application/json' } }))
  } catch {
    // Storage refused. The setting still applies for this session.
  }
  return cached
}

export const supported = () =>
  typeof Notification !== 'undefined' && 'serviceWorker' in navigator

/**
 * The active service worker, or null, without waiting around for one.
 *
 * `navigator.serviceWorker.ready` never settles when no worker is registered —
 * every `npm run dev` session, every browser where registration failed, and the
 * first load of a fresh install. Racing it against a timeout was worse than
 * useless: the toggle sat there for the length of the timeout every single time
 * before doing anything, which is exactly the "takes ages to turn on and off"
 * this caused.
 *
 * `getRegistration()` settles immediately — undefined when there is nothing.
 * Only when a registration exists but has not activated yet is `ready` worth
 * waiting on, and then only briefly.
 */
async function swReady() {
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return null
    if (reg.active) return reg
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ])
  } catch {
    return null
  }
}

/**
 * Whether to show the one-time "turn these on" card (components/NotifyPrompt).
 *
 * Reminders are on by default, but a browser will not — and should not — hand
 * out the permission without a gesture. Riding the first tap anywhere was the
 * obvious shortcut and the wrong one: on this app the first tap is usually the
 * drop zone, and a permission prompt landing on top of the file picker is a
 * good way to get denied forever. So it is asked for once, on a button that
 * says what it is for, and never raised again either way.
 */
export async function shouldAsk() {
  if (!supported() || Notification.permission !== 'default') return false
  const prefs = await readPrefs()
  return Boolean(prefs.enabled) && !prefs.asked
}

/** Remember that the card was answered, whichever way. */
export const markAsked = () => writePrefs({ asked: true })

/** Permission is a user gesture away, always. Never called on load. */
export async function enable() {
  if (!supported()) throw new Error('This browser has no notifications.')
  const granted = await Notification.requestPermission()
  if (granted !== 'granted') throw new Error('Notifications are blocked for this site.')
  await writePrefs({ enabled: true })
  // Not awaited. Background Sync is an optimisation — it only decides whether
  // reminders can also fire with the app closed — and the switch has no reason
  // to sit there while the browser makes up its mind about it.
  registerPeriodicSync().catch(() => {})
  return true
}

export async function disable() {
  await writePrefs({ enabled: false })
  // Same: the preference is what stops the reminders, and it is already
  // written. Tearing down the background registration can take its time.
  swReady()
    // periodicSync is Chromium-only and gated on the app being installed.
    .then((reg) => reg?.periodicSync?.unregister('hisaab-reminders'))
    .catch(() => {})
}

async function registerPeriodicSync() {
  try {
    const reg = await swReady()
    if (!reg?.periodicSync) return // Safari, Firefox, or not installed
    const ok = await navigator.permissions
      ?.query({ name: 'periodic-background-sync' })
      .then((s) => s.state === 'granted')
      .catch(() => false)
    if (!ok) return
    // Four hours. The worker decides whether anything is actually due; asking
    // for a tighter interval only makes Chrome ignore it.
    await reg.periodicSync.register('hisaab-reminders', { minInterval: 4 * 60 * 60 * 1000 })
  } catch {
    // Unsupported or refused. The in-page checks below still run.
  }
}

// ── What to say, and when ──────────────────────────────────────────────────

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long' })

/**
 * Every reminder that is due right now and hasn't already fired for its period.
 * `facts` is what the page knows and the worker doesn't — pass {} from the
 * worker and the reminders that need no facts still fire.
 */
export function due(prefs, facts = {}, now = new Date()) {
  const out = []
  const day = iso(now)
  const month = day.slice(0, 7)
  const already = (id, period) => prefs.shown?.[id] === period

  // The 1st, once. A budget set on the 3rd is worth less than one set on the
  // 1st, and this is the one thing the ledger can never work out on its own.
  if (prefs.monthly && now.getDate() === 1 && !already('budget', month) && !facts.hasBudget) {
    out.push({
      id: 'budget',
      period: month,
      title: `${MONTH.format(now)} has started`,
      body: 'Set what you want this month to cost, and every category gets a target.',
      tab: 'budgets',
    })
  }

  // The daily ask, at the hour they chose. Skipped on a day that already has
  // rows — nagging someone who already logged is how an app gets muted.
  if (prefs.daily && now.getHours() >= prefs.dailyHour && !already('daily', day) && !facts.loggedToday) {
    out.push({
      id: 'daily',
      period: day,
      title: 'Anything to add today?',
      body: 'Drop in the day’s payment screenshots — they’re read on your phone.',
      tab: 'today',
    })
  }

  // A repeat that has come due. Not tied to the daily hour: rent being due is
  // worth saying at breakfast, and it is the one reminder here that is about
  // something with a date rather than a habit.
  //
  // Page-only, like the Sunday nudge below — public/reminders.js has no way to
  // read the ledger, so it cannot know. Whichever runs first wins the day
  // through `shown`.
  if (prefs.bills && !already('bills', day) && (facts.billsDue ?? 0) > 0) {
    const n = facts.billsDue
    out.push({
      id: 'bills',
      period: day,
      title: `${n} repeat${n === 1 ? '' : 's'} due`,
      body: 'Confirm the ones that happened — nothing is added to your ledger until you do.',
      tab: 'repeats',
    })
  }

  // Sunday, and only if there is genuinely something waiting.
  if (prefs.weekly && now.getDay() === 0 && !already('weekly', day)) {
    const n = (facts.reviewCount ?? 0) + (facts.untaughtCount ?? 0)
    if (n > 0) {
      out.push({
        id: 'weekly',
        period: day,
        title: `${n} thing${n === 1 ? '' : 's'} waiting`,
        body: 'A few rows need a look, or a merchant needs a name. Two minutes.',
        tab: 'review',
      })
    }
  }

  return out
}

/** Fire whatever is due. Safe to call as often as you like. */
export async function check(facts = {}) {
  if (!supported() || Notification.permission !== 'granted') return 0
  const prefs = await readPrefs()
  if (!prefs.enabled) return 0

  const list = due(prefs, facts)
  if (list.length === 0) return 0

  const reg = await swReady()
  if (!reg) return 0

  const shown = { ...prefs.shown }
  for (const r of list) {
    await reg.showNotification(r.title, {
      body: r.body,
      // No `icon` — Android already draws the installed app's launcher icon on
      // the left, and `icon` only adds a duplicate on the right of the card.
      //
      // `badge` is the small status-bar mark, and Android reads its ALPHA
      // CHANNEL ONLY, painting every opaque pixel flat white. icon-192.png is
      // opaque edge to edge, so it drew a solid white square. badge-96.png is a
      // transparent silhouette built for this by scripts/make-icons.mjs.
      // public/reminders.js fires the same reminders with the app closed and
      // must stay in step with this.
      badge: '/badge-96.png',
      // One per kind: a second daily nudge replaces the first rather than
      // stacking a column of identical cards in the shade.
      tag: `hisaab-${r.id}`,
      data: { tab: r.tab },
    })
    shown[r.id] = r.period
  }
  await writePrefs({ shown })
  return list.length
}

/** Run the check now, on every return to the app, and every ten minutes while
 *  it is open. `getFacts` may be async — the caller reads them off the database
 *  and they go stale over a long session. Returns the teardown. */
export function watch(getFacts) {
  if (!supported()) return () => {}
  const run = () => Promise.resolve(getFacts()).then(check).catch(() => {})
  run()
  const timer = setInterval(run, 10 * 60 * 1000)
  const onVisible = () => document.visibilityState === 'visible' && run()
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
