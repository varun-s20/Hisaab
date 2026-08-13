// The exit door's file format, with nothing in it that touches the network.
//
// Split from lib/export.js so `node scripts/test-parse.mjs` can check the round
// trip: export.js imports db.js, which builds a Supabase client the moment it
// loads. The thing worth testing is that the writer and lib/statement's reader
// agree, and that is all pure.
//
// You arrived here by exporting a CSV out of another app, so the least this one
// owes you is the same file back. The header names are ones detectColumns
// already claims, so a round trip lands on the same rows rather than on a
// screen full of "no readable date".

const HEADERS = [
  ['Date', (r) => r.txn_date],
  ['Time', (r) => r.txn_time ?? ''],
  ['Description', (r) => r.payee_clean || r.payee_raw || ''],
  ['Amount', (r) => (r.amount == null ? '' : Number(r.amount).toFixed(2))],
  ['Type', (r) => r.type ?? ''],
  ['Category', (r) => r.category ?? ''],
  ['Account', (r) => r.account ?? ''],
  // Read back as an account column would claim it, so it is named as its own
  // thing. Re-importing loses the destination — a transfer comes back as one
  // row leaving one pocket, which is what the schema stores anyway.
  ['To account', (r) => r.to_account ?? ''],
  ['Method', (r) => r.method ?? ''],
  ['Reference', (r) => r.txn_ref ?? ''],
  ['Note', (r) => r.note ?? ''],
]

/**
 * A cell a spreadsheet would evaluate rather than display.
 *
 * Excel, LibreOffice and Sheets all treat a cell starting `= + @` — and a tab
 * or carriage return — as a formula, and RFC-4180 quoting does NOT stop it: the
 * quotes are consumed as CSV syntax and what is left is evaluated. A leading
 * apostrophe is what marks the value as literal text.
 *
 * This is not theoretical here. `payee_raw` is OCR'd off a payment screenshot,
 * and the display name in that screenshot is chosen by whoever you paid — so a
 * merchant can pick a name that runs when you open your own export. `note` and
 * the account names carried in by an import are the same shape of problem.
 *
 * A leading `-` is left alone when the cell is a real negative number, which is
 * an ordinary value in a ledger, not an attack.
 */
const evaluates = (s) => /^[=+@\t\r]/.test(s) || (s.startsWith('-') && Number.isNaN(Number(s)))

/**
 * RFC-4180. Everything is quoted rather than only the fields that need it —
 * the cost is a few bytes, and the alternative is deciding per cell whether a
 * merchant name contains a comma. `"` doubles.
 */
const cell = (v) => {
  const s = String(v ?? '')
  return `"${(evaluates(s) ? `'${s}` : s).replace(/"/g, '""')}"`
}

export function toCSV(rows) {
  const lines = [HEADERS.map(([h]) => cell(h)).join(',')]
  for (const r of rows) lines.push(HEADERS.map(([, read]) => cell(read(r))).join(','))
  // Trailing newline: without it the last row has no terminator and some
  // spreadsheets quietly drop it.
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Hand the file to the browser.
 *
 * Lives beside the writer rather than in lib/export.js, which is where it used
 * to be: the Ledger exports a CSV too, and reaching into export.js for this
 * would drag db.js and the whole migration machinery into the main bundle for
 * fifteen lines. Nothing here touches the network or a database, same as the
 * rest of this file. export.js re-exports it, so its own callers are unchanged.
 *
 * Every detail below is something that only breaks on somebody else's machine:
 *
 *   the BOM      Excel on Windows otherwise reads the file as the system
 *                codepage, and a merchant name in Devanagari — or a plain ₹ —
 *                comes out as mojibake. Every other reader ignores it.
 *   in the tree  Safari ignores a click on an anchor that was never in the
 *                document, and this app is mostly opened on a phone.
 *   the timeout  revoking the object URL in the same tick as the click races
 *                the download that click just started.
 */
export function download(csv, name = 'hisaab.csv') {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
