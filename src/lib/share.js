// Client half of the Web Share Target. The service worker parked the shared
// screenshots in the Cache API and redirected here with ?shared=1; this reads
// them out once, deletes them, and hands back real File objects so the normal
// ingest path doesn't need to know a share happened.

const SHARE_CACHE = 'hisaab-shared'
const SHARE_KEY = '/__shared-screenshots'

const toFile = ({ name, type, data, lastModified }) => {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  // Without lastModified a rebuilt File claims it was created just now, and the
  // parser dates every "Paid Today" row to the day of the share rather than the
  // day of the payment.
  return new File([bytes], name, { type, lastModified: lastModified || Date.now() })
}

/** [] unless the app was just opened from a share. Safe to call on every mount. */
export async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared')) return []

  try {
    const cache = await caches.open(SHARE_CACHE)
    const res = await cache.match(SHARE_KEY)
    if (!res) return []
    const items = await res.json()
    await cache.delete(SHARE_KEY)
    // The flag comes off only once the entry is read and gone, so the two can't
    // disagree. Stripping it first meant a read that threw — or a tab that died
    // mid-flight — left the screenshots parked in the cache with nothing left
    // pointing at them. App's own replaceState keeps whatever URL it finds.
    history.replaceState(history.state, '', location.pathname)
    return Array.isArray(items) ? items.map(toFile) : []
  } catch {
    return [] // A share that can't be read is a normal cold start, not an error.
  }
}
