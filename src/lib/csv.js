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
