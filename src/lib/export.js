import { listTransactions } from './db'
import { toCSV } from './csv'
import { today } from './format'

// The exit door. The file format is in lib/csv.js; this is the part that has to
// talk to the database and the browser.

/**
 * Every row, oldest first. `listTransactions` pages past PostgREST's 1000-row
 * cap, so the only ceiling is the one asked for here.
 *
 * ponytail: 20000 rows is roughly twenty years of heavy use and about 2MB of
 * text, which is fine to build in memory on a phone. A ledger past that wants
 * streaming, and will say so by being slow.
 */
export async function exportAll() {
  const rows = await listTransactions({ limit: 20000 })
  return toCSV([...rows].reverse())
}

/** Hand the file to the browser. Revoked on the next tick, not left to leak. */
export function download(csv, name = `hisaab-${today()}.csv`) {
  // ﻿: without the BOM, Excel on Windows reads the file as the system
  // codepage and a merchant name in Devanagari — or a plain ₹ — comes out as
  // mojibake. Every other reader ignores it.
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  // In the document, not detached: Safari ignores a click on an anchor that
  // was never in the tree, and this app is mostly opened on a phone.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
