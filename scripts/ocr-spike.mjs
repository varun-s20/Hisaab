// OCR spike — BUILD_GUIDE.md §6.1, run on the desktop instead of the phone.
// Reads every image in ./screenshots and dumps raw Tesseract text to
// ./screenshots/ocr-output.txt. That output is the spec for every parser.
//
//   npm run ocr
//
// Same tesseract.js build the app uses, so the strings here match what the
// PWA will see at runtime.

import { createWorker } from 'tesseract.js'
import { readdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const DIR = 'screenshots'
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

const files = (await readdir(DIR))
  .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
  .sort()

if (files.length === 0) {
  console.error(`No images in ./${DIR}. Drop your GPay/PhonePe/Paytm screenshots there first.`)
  process.exit(1)
}

console.log(`Found ${files.length} image(s). First run downloads ~10MB of language data.`)

const worker = await createWorker('eng')
let out = ''

for (const file of files) {
  process.stdout.write(`  ${file} ... `)
  const { data } = await worker.recognize(join(DIR, file))
  out += `\n===== ${file} =====\n${data.text}\n`
  console.log(`${data.text.trim().split('\n').length} lines`)
}

await worker.terminate()

const dest = join(DIR, 'ocr-output.txt')
await writeFile(dest, out, 'utf8')
console.log(`\nWrote ${dest}`)
