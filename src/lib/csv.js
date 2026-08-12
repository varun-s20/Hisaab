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
 * RFC-4180. Everything is quoted rather than only the fields that need it —
 * the cost is a few bytes, and the alternative is deciding per cell whether a
 * merchant name contains a comma. `"` doubles.
 */
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

export function toCSV(rows) {
  const lines = [HEADERS.map(([h]) => cell(h)).join(',')]
  for (const r of rows) lines.push(HEADERS.map(([, read]) => cell(read(r))).join(','))
  // Trailing newline: without it the last row has no terminator and some
  // spreadsheets quietly drop it.
  return `${lines.join('\r\n')}\r\n`
}
