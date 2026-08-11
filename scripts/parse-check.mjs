// Parses screenshots/ocr-output.txt and prints what the app would save.
// Run after `npm run ocr` to eyeball the parser against real screenshots
// before trusting it with the database.
//
//   node scripts/parse-check.mjs

import { readFileSync } from 'node:fs'
import { parseScreenshot, synthRef } from '../src/lib/parse.js'

const text = readFileSync('screenshots/ocr-output.txt', 'utf8')
const shots = text.split(/^===== (.+?) =====$/m).slice(1)

let all = []
for (let i = 0; i < shots.length; i += 2) {
  const rows = parseScreenshot(shots[i + 1])
  console.log(`\n===== ${shots[i]} — ${rows.length} row(s) =====`)
  for (const r of rows) {
    const flag = r.needs_review ? '!' : ' '
    console.log(
      `${flag} ${(r.txn_date ?? '??????????').padEnd(10)} ${(r.txn_time ?? '     ').slice(0, 5).padEnd(5)}` +
        ` ${(r.direction === 'credit' ? '+' : '-')}${String(r.amount ?? '?').padStart(9)}` +
        `  ${String(r.payee_raw ?? '?').slice(0, 32).padEnd(32)} ${r.category_hint ?? ''}`,
    )
  }
  all = all.concat(rows)
}

const refs = new Set(all.map(synthRef))
const bad = all.filter((r) => !r.amount || !r.txn_date || !r.payee_raw)

console.log(`\n${all.length} transactions from ${shots.length / 2} screenshots`)
console.log(`${refs.size} unique dedup keys (${all.length - refs.size} collisions)`)
console.log(`${bad.length} would be flagged for review`)
console.log(`${all.filter((r) => r.category_hint).length} categorised by the app's own tag, no AI needed`)
