let workerPromise = null

// Everything is served from our own origin. By default tesseract.js pulls its
// worker script, its WASM core and the language data from jsdelivr at runtime,
// and the worker script is re-instantiated as a *same-origin* Worker that is
// then handed the raw pixels of every screenshot. A CDN is a third party with
// code execution inside the one part of this app that promises the image never
// leaves the device — and the CacheFirst rule that used to cover those URLs
// would have pinned a bad response on the phone permanently.
//
// The files live in public/tesseract/, copied from the installed packages.
// Re-copy them after a tesseract.js upgrade or the core and the worker drift.
const LOCAL = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/',
  langPath: '/tesseract/',
  gzip: false, // eng.traineddata is stored uncompressed
}

// One worker, reused across the whole batch. Creating one per image is the
// classic performance bug — it re-inits WASM every time.
//
// tesseract.js is imported here rather than at the top of the file, and that is
// the whole point of the async: statically imported it lands in the entry chunk,
// so the bytes that read a screenshot were parsed before the sign-in screen
// could paint — on the one screen that has no screenshot on it. Today calls
// preload() 400ms after mount, so the fetch still happens while somebody is
// reading the page and the first drop is still warm.
async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng', 1, LOCAL))
  }
  return workerPromise
}

/** Warm the worker up during idle time so the first upload isn't a cold start. */
export function preload() {
  getWorker().catch(() => {
    workerPromise = null
  })
}

export async function readImage(file) {
  const worker = await getWorker()
  const { data } = await worker.recognize(file)
  return data.text
  // `file` goes out of scope here and is never uploaded or persisted.
  // This is the privacy guarantee. Do not add a storage call.
}

/**
 * When the screenshot was taken, as far as the file knows.
 *
 * This is what "Paid Today, 07:18 AM" has to be resolved against. Every payment
 * app writes the date relatively, so a Tuesday screenshot uploaded on Wednesday
 * was being read as Wednesday's payment — the row was right about everything
 * except the one field the screenshot never states outright.
 *
 * Falsy, absurdly old, or in the future means the browser has nothing real (a
 * File rebuilt from bytes reports 0 or now); fall back to the clock, which is
 * where this started.
 */
function takenAt(file) {
  const ms = Number(file?.lastModified)
  const now = Date.now()
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + 60_000) return new Date(now)
  // Older than two years is a copied or re-encoded file whose stamp is junk.
  if (now - ms > 2 * 365 * 86400_000) return new Date(now)
  return new Date(ms)
}

export async function readBatch(files, onProgress) {
  const results = []
  for (let i = 0; i < files.length; i++) {
    let text = ''
    try {
      text = await readImage(files[i])
    } catch {
      text = '' // A dud image shouldn't kill the batch; it lands as unreadable.
    }
    results.push({ name: files[i].name, text, when: takenAt(files[i]) })
    onProgress?.(i + 1, files.length)
  }
  return results
}
