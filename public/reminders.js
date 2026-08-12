/* Imported into the generated service worker (see vite.config.js
 * workbox.importScripts).
 *
 * Two jobs, both of which only the worker can do:
 *
 *   periodicsync — Chrome wakes an installed PWA every few hours even with the
 *     app closed. This is the only way a reminder arrives without a server, and
 *     it is why there are no VAPID keys or a subscriptions table in this repo.
 *     The worker cannot read localStorage, so preferences travel through a
 *     Cache entry the page writes (src/lib/notify.js).
 *
 *   notificationclick — a tap has to land in the app, on the screen the
 *     reminder was about, focusing the window that is already open rather than
 *     opening a second one.
 *
 * Facts the worker has no access to — whether anything was logged today, how
 * many rows need a look — are simply absent here, so the reminders that depend
 * on them stay quiet and the page's own check (which has them) fires instead
 * the next time the app is opened.
 */

const PREFS_CACHE = 'hisaab-prefs'
const PREFS_KEY = '/__reminders'

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

async function readPrefs() {
  try {
    const cache = await caches.open(PREFS_CACHE)
    const hit = await cache.match(PREFS_KEY)
    return hit ? await hit.json() : null
  } catch {
    return null
  }
}

async function writePrefs(prefs) {
  try {
    const cache = await caches.open(PREFS_CACHE)
    await cache.put(
      PREFS_KEY,
      new Response(JSON.stringify(prefs), { headers: { 'content-type': 'application/json' } }),
    )
  } catch {
    // Storage refused. The reminder still went out; it may simply repeat.
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'hisaab-reminders') return
  event.waitUntil(fire())
})

async function fire() {
  const prefs = await readPrefs()
  if (!prefs?.enabled) return

  const now = new Date()
  const day = isoDay(now)
  const month = day.slice(0, 7)
  const shown = { ...(prefs.shown ?? {}) }
  const out = []

  if (prefs.monthly !== false && now.getDate() === 1 && shown.budget !== month) {
    out.push({
      id: 'budget',
      period: month,
      title: 'A new month has started',
      body: 'Set what you want it to cost, and every category gets a target.',
      tab: 'budgets',
    })
  }

  // No way to know from here whether anything was logged today; the page skips
  // this one when the day already has rows, and whichever runs first wins the
  // day through `shown`.
  if (prefs.daily !== false && now.getHours() >= (prefs.dailyHour ?? 21) && shown.daily !== day) {
    out.push({
      id: 'daily',
      period: day,
      title: 'Anything to add today?',
      body: 'Drop in the day’s payment screenshots — they’re read on your phone.',
      tab: 'today',
    })
  }

  for (const r of out) {
    await self.registration.showNotification(r.title, {
      body: r.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `hisaab-${r.id}`,
      data: { tab: r.tab },
    })
    shown[r.id] = r.period
  }
  if (out.length > 0) await writePrefs({ ...prefs, shown })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const tab = event.notification.data?.tab ?? 'today'
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin) {
          // The app reads this and switches screens (src/App.jsx).
          c.postMessage({ type: 'hisaab-open', tab })
          return c.focus()
        }
      }
      return self.clients.openWindow(`/?open=${encodeURIComponent(tab)}`)
    })(),
  )
})
