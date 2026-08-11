import { createWorker } from 'tesseract.js'

let workerPromise = null

// One worker, reused across the whole batch. Creating one per image is the
// classic performance bug — it re-inits WASM every time.
function getWorker() {
  if (!workerPromise) workerPromise = createWorker('eng')
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
