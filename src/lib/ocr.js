import { createWorker } from 'tesseract.js'

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
function getWorker() {
  if (!workerPromise) workerPromise = createWorker('eng', 1, LOCAL)
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

export async function readBatch(files, onProgress) {
  const results = []
  for (let i = 0; i < files.length; i++) {
    let text = ''
    try {
      text = await readImage(files[i])
    } catch {
      text = '' // A dud image shouldn't kill the batch; it lands as unreadable.
    }
    results.push({ name: files[i].name, text })
    onProgress?.(i + 1, files.length)
  }
  return results
}
