/* Imported into the generated service worker (see vite.config.js workbox.importScripts).
 *
 * Android's share sheet POSTs the shared files to /share-target. A POST cannot
 * be handed to a client page directly, so the files are parked in the Cache API
 * under a known URL and the browser is redirected to the app, which picks them
 * up and deletes them. This is the standard Web Share Target flow.
 *
 * Only works on an installed PWA over HTTPS — there is no service worker in
 * `npm run dev`, so this path cannot be exercised locally. */

const SHARE_CACHE = 'hisaab-shared'
const SHARE_KEY = '/__shared-screenshots'

/**
 * A service worker intercepts navigations into its own scope whoever started
 * them, so a cross-origin <form method="POST" enctype="multipart/form-data">
 * reaches this handler exactly like the Android share sheet does — and a page
 * can fill a file input programmatically, so the image/* filter below is no
 * obstacle. The share sheet sends no referrer; a page submitting a form does.
 *
 * This is a cheap first cut, not the guarantee: an attacker can suppress the
 * referrer. The real defence is that nothing is imported without a tap — see
 * the confirmation card in src/screens/Today.jsx. Do not remove that and rely
 * on this.
 */
function sameOriginShare(request) {
  if (!request.referrer) return true // the share sheet, or a referrer-less client
  try {
    return new URL(request.referrer).origin === self.location.origin
  } catch {
    return false
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return

  event.respondWith(
    (async () => {
      try {
        if (!sameOriginShare(event.request)) {
          console.warn('[share-target] refused a share from', event.request.referrer)
          return Response.redirect('/', 303)
        }
        const form = await event.request.formData()
        const files = form.getAll('images').filter((f) => f && f.type?.startsWith('image/'))
        if (files.length > 0) {
          const cache = await caches.open(SHARE_CACHE)
          // One entry holding every shared file, so the client makes one read
          // and one delete however many screenshots were sent.
          await cache.put(
            SHARE_KEY,
            new Response(
              new Blob([JSON.stringify(await Promise.all(files.map(serialise)))], {
                type: 'application/json',
              }),
            ),
          )
        }
      } catch (e) {
        // A failed share must still land the user in the app, not on an error page.
        console.error('[share-target]', e)
      }
      return Response.redirect('/?shared=1', 303)
    })(),
  )
})

async function serialise(file) {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000 // apply() blows the stack on a whole 4MB screenshot
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  // lastModified travels with it: the parser dates "Paid Today" against when
  // the screenshot was taken, and a File rebuilt on the other side reports the
  // moment it was rebuilt unless we carry the real one across.
  return {
    name: file.name || 'screenshot.png',
    type: file.type,
    lastModified: file.lastModified || 0,
    data: btoa(binary),
  }
}
