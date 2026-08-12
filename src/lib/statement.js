// Statement reconciliation — BUILD_GUIDE.md §8.2.
//
// Screenshots catch ~70% of transactions. Once a month a CSV export from
// GPay/PhonePe/Paytm or the bank catches the rest. This file only turns text
// into the same row shape parse.js produces; dedup against existing txn_refs
// belongs to db.saveTransactions and stays there.

// Extensions are explicit so `selfTest()` can be run straight from node.
import { extractDate, extractTime, toNumber } from './parse.js'
import { iso } from './format.js'

// ── CSV ──────────────────────────────────────────────────────────────────────
/**
 * RFC-4180-ish, hand-written. Quoted fields, "" escapes inside quotes, commas
 * and newlines inside quotes, \r\n and \n. Fully blank rows are dropped —
 * bank exports are full of them and no caller wants them back.
 */
export function parseCSV(text, delim = ',') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }

  // Undo the formula guard lib/csv.js writes, so exporting and re-importing
  // gives the name back rather than a stray apostrophe. Narrow on purpose: an
  // apostrophe followed by one of these characters is an escape, never a name.
  const unguard = (f) => (/^'[=+@\t\r-]/.test(f) ? f.slice(1) : f)

  return rows.filter((r) => r.some((f) => f.trim() !== '')).map((r) => r.map(unguard))
}

/** Bank "text exports" are often tab or pipe separated. Comma wins ties. */
function sniff(text) {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  const count = (ch) => line.split(ch).length - 1
  return [',', '\t', ';', '|'].sort((a, b) => count(b) - count(a))[0]
}

// ── Column detection ─────────────────────────────────────────────────────────
// Every name an Indian bank or UPI app has been seen to use, plus the ones the
// budgeting apps use — MyMoney, Money Manager, Wallet, Monefy — because a
// person arriving with years of history exports it from one of those, not from
// a bank. A hand-made Google Sheet is the same problem with worse spelling.
//
// Resolved in the order listed below, each column claimed once — so "Debit
// Amount" is taken by `debit` before `amount` ever gets to look at it.
//
// `category` and `account` are resolved BEFORE `description`, and that order is
// load-bearing: description matches 'name' and 'to' by whole-token containment,
// so listed after them it would claim "Account Name" and leave the real note
// column unread.
const NAMES = {
  // 'time' is here because MyMoney's only date column is called TIME and holds
  // "Jul 09, 2026 10:59 AM". A file with separate Date and Time columns is
  // unaffected: the exact-match pass claims "Date" before containment runs.
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'date time', 'txn date time', 'transaction datetime', 'completion time', 'time', 'datetime', 'timestamp'],
  ref: ['ref', 'reference', 'ref no', 'ref number', 'reference no', 'reference number', 'txn ref', 'transaction ref', 'utr', 'utr no', 'transaction id', 'txn id', 'upi transaction id', 'cheque no', 'chq no', 'cheque number', 'ref number cheque number'],
  type: ['type', 'txn type', 'transaction type', 'dr cr', 'cr dr', 'debit credit', 'income expense', 'expense income'],
  category: ['category', 'category name', 'main category', 'parent category'],
  account: ['account', 'account name', 'wallet', 'from account', 'to account', 'paid from'],
  debit: ['debit', 'debit amount', 'debit amt', 'withdrawal', 'withdrawal amt', 'withdrawal amount', 'withdrawals', 'dr', 'paid out', 'money out'],
  credit: ['credit', 'credit amount', 'credit amt', 'deposit', 'deposit amt', 'deposit amount', 'deposits', 'cr', 'paid in', 'money in'],
  // No 'value' alias here — it would claim HDFC's "Value Dt" column.
  amount: ['amount', 'txn amount', 'transaction amount', 'amount inr', 'amount in inr', 'amt', 'inr', 'cost', 'price', 'spent'],
  description: ['description', 'narration', 'particulars', 'details', 'transaction details', 'remarks', 'merchant', 'merchant name', 'payee', 'paid to', 'to', 'from', 'name', 'note', 'notes', 'memo', 'comment', 'comments', 'item', 'title', 'subject', 'for'],
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function claim(headers, names, used) {
  // Exact match first, then whole-token containment — so 'to' never matches
  // "Total" and 'dr' never matches "Address".
  for (const pass of [0, 1]) {
    for (const n of names) {
      const i = headers.findIndex((h, idx) =>
        !used.has(idx) && (pass === 0 ? h === n : ` ${h} `.includes(` ${n} `)))
      if (i !== -1) { used.add(i); return i }
    }
  }
  return -1
}

export function detectColumns(headerRow) {
  const headers = (headerRow ?? []).map(norm)
  const used = new Set()
  const out = { date: -1, amount: -1, debit: -1, credit: -1, description: -1, ref: -1, type: -1, category: -1, account: -1 }
  for (const key of Object.keys(NAMES)) out[key] = claim(headers, NAMES[key], used)
  return out
}

/** Statements bury the header under a few lines of account preamble. */
function findHeader(table) {
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const columns = detectColumns(table[i])
    if (columns.date >= 0 && (columns.amount >= 0 || columns.debit >= 0 || columns.credit >= 0)) {
      return { at: i, columns }
    }
  }
  return { at: -1, columns: detectColumns([]) }
}

// ── Cell readers ─────────────────────────────────────────────────────────────
// `income` and `expense` are in here because that is how every budgeting app
// writes the type column, and neither word matched before: "(+) Income" fell
// through every branch to the 'debit' default at the end of the chain, so a
// ₹43,470 salary imported as ₹43,470 spent — wrong in money-out and money-in at
// the same time, from one row.
const dirFrom = (s) =>
  /\b(cr|credit|credited|deposit|received|refund|income|earning|earnings)\b/i.test(s) ? 'credit'
  : /\b(dr|debit|debited|withdrawal|withdrawn|sent|paid|expense|spend|spent)\b/i.test(s) ? 'debit'
  : null

/**
 * The category to file the row under when the file states its own kind.
 *
 * A budgeting app's type column is a fact the row carries about itself, and it
 * outranks anything guessed from a name — so it is turned into the category the
 * cascade would have had to reach, and `typeFor` in lib/categorise.js does the
 * rest: 'Transfers' becomes type `transfer`, 'Income' on a credit becomes type
 * `income`. Nothing new to consume, and money moving between your own envelopes
 * stops being counted as spending.
 *
 * Deliberately NOT matching 'cr' / 'credit' / 'deposit': those are what a bank
 * statement puts in the same column, and an unrecognised bank credit is usually
 * a friend paying you back, not income. That call already belongs to `typeFor`
 * and this must not quietly overrule it.
 */
function statedCategory(cell) {
  if (!cell) return null
  if (/\btransfers?\b/i.test(cell)) return 'Transfers'
  if (/\b(income|salary|earning|earnings)\b/i.test(cell)) return 'Income'
  return null
}

/**
 * Another app's category vocabulary, mapped onto the fourteen this app has.
 *
 * Only unambiguous synonyms. Anything not listed passes through unchanged — a
 * "Gift" or a "DebtPayment" column stays that word rather than being flattened
 * into Other, because the person spent years filing it that way and the row
 * carries the text either way. Add it in the picker to give it a colour.
 */
const CATEGORY_ALIAS = {
  food: 'Food & Dining', dining: 'Food & Dining', 'eating out': 'Food & Dining',
  restaurant: 'Food & Dining', restaurants: 'Food & Dining', 'food drinks': 'Food & Dining',
  grocery: 'Groceries', supermarket: 'Groceries', vegetables: 'Groceries',
  transportation: 'Transport', travel: 'Transport', fuel: 'Transport', petrol: 'Transport',
  taxi: 'Transport', commute: 'Transport',
  telephone: 'Bills & Utilities', phone: 'Bills & Utilities', mobile: 'Bills & Utilities',
  utilities: 'Bills & Utilities', bills: 'Bills & Utilities', internet: 'Bills & Utilities',
  recharge: 'Bills & Utilities', electricity: 'Bills & Utilities',
  grooming: 'Personal Care', beauty: 'Personal Care', salon: 'Personal Care',
  social: 'Entertainment', 'social life': 'Entertainment', leisure: 'Entertainment',
  movies: 'Entertainment', culture: 'Entertainment',
  electronics: 'Shopping', clothing: 'Shopping', apparel: 'Shopping', clothes: 'Shopping',
  medical: 'Health', medicine: 'Health', fitness: 'Health', gym: 'Health', doctor: 'Health',
  salary: 'Income', wage: 'Income', wages: 'Income',
  housing: 'Rent', accommodation: 'Rent',
  study: 'Education', tuition: 'Education',
  transfer: 'Transfers', 'self transfer': 'Transfers',
}

/**
 * An account cell, split into the pocket the money left and the one it landed
 * in. A budgeting app writes both sides of a transfer into one cell —
 * "SBI Bank->Needs" — and left whole that string becomes its own account: it
 * shows in the picker, in "group by account", and in a balance for an envelope
 * that does not exist.
 *
 * Split on the first arrow only. An account name may legitimately contain a
 * hyphen; the separator is always the pair.
 */
function readAccount(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return { account: null, to_account: null }
  const at = s.indexOf('->')
  if (at < 0) return { account: s.slice(0, 40), to_account: null }
  return {
    account: s.slice(0, at).trim().slice(0, 40) || null,
    to_account: s.slice(at + 2).trim().slice(0, 40) || null,
  }
}

/**
 * A category cell as this app spells it. MyMoney writes "  -  " on a transfer,
 * where the field means "not applicable" rather than a category called dash.
 */
function readCategory(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s || /^[-–—.]+$/.test(s)) return null
  return CATEGORY_ALIAS[s.toLowerCase()] ?? s.slice(0, 28)
}

/**
 * "₹1,00,000.50 Dr" → { value: 100000.5, dir: 'debit' }.
 * Indian grouping is stripped before Number() — parseFloat('1,00,000') is 1,
 * which is the 100× bug. A 0.00 cell (the unused half of a debit/credit pair)
 * reads as no amount, which is what it means.
 */
function readAmount(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = toNumber(s.replace(/[^\d.,]/g, ''))
  if (n == null) return null
  // A single-amount column carries its direction in the sign. Reading '-' but
  // not '+' meant "+5,000" fell through to the 'debit' default at the end of
  // the chain below, and ₹5,000 received was booked as ₹5,000 spent — an error
  // of ₹5,000 in money-out and another ₹5,000 in money-in, from one row.
  const signed = /^[-(]/.test(s) ? 'debit' : /^\+/.test(s) ? 'credit' : null
  return { value: n, dir: dirFrom(s) ?? signed }
}

const ISO_DATE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/

/** ISO here, everything else via parse.js — which is already day-first. */
function readDate(raw, now) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const m = s.match(ISO_DATE)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? iso(d) : null
  }
  return extractDate(s, now)
}

// UPI stays null — `method` carries the app name on the screenshot path, and a
// statement can't tell you which app it was.
const METHOD = /\b(IMPS|NEFT|RTGS|ATM|POS|ECS|NACH|EMI|CHQ|CHEQUE|CARD)\b/i

// ── The parser ───────────────────────────────────────────────────────────────
export function parseStatement(text, { now = new Date() } = {}) {
  const table = parseCSV(text, sniff(text))
  const { at: headerAt, columns } = findHeader(table)
  const header = headerAt >= 0 ? table[headerAt].map((c) => c.trim()) : []
  const rows = []
  const skipped = []

  if (headerAt < 0) {
    skipped.push({
      line: 1,
      reason: 'No date and amount columns found. Check the export format.',
      text: (table[0] ?? []).join(' | ').slice(0, 120),
    })
    return { rows, skipped, columns, header }
  }

  for (let i = headerAt + 1; i < table.length; i++) {
    const cells = table[i]
    const at = (k) => (columns[k] >= 0 ? String(cells[columns[k]] ?? '').trim() : '')
    const raw_text = cells.join(' | ').trim()
    const drop = (reason) => skipped.push({ line: i + 1, reason, text: raw_text.slice(0, 120) })

    // More cells than headers means an unquoted comma inside a field — usually
    // an ungrouped "1,00,000.50". Every column after it is misaligned, so the
    // amount would be silently wrong. Report it instead of importing a lie.
    if (cells.length > header.length) { drop('Row does not line up with the header'); continue }

    // Never silently dropped: a row that can't be read is reported, not lost.
    const txn_date = readDate(at('date'), now)
    if (!txn_date) { drop('No readable date'); continue }

    const debit = readAmount(at('debit'))
    const credit = readAmount(at('credit'))
    const single = readAmount(at('amount'))
    const hit = debit ?? credit ?? single
    if (!hit) { drop('No readable amount'); continue }

    const direction = debit ? 'debit' : credit ? 'credit' : (single.dir ?? dirFrom(at('type')) ?? 'debit')
    const { account, to_account } = readAccount(at('account'))

    // A budgeting app's own word for the row wins; otherwise its category
    // column, mapped onto ours. Either way this is `category_hint`, which the
    // cascade in lib/categorise.js already reads at tier 2 — above the seed
    // rules and above the personal-name check, and below a correction the user
    // made themselves. Nothing there needed changing.
    const category_hint = statedCategory(at('type')) ?? readCategory(at('category'))

    // Fall back rather than lose the row. A note column is often blank on the
    // rows a person entered in a hurry, and `db.saveTransactions` drops
    // anything with no payee at all — so an amount, a date and a category would
    // have been thrown away for want of a name. The category, then the account,
    // are the next most descriptive things the row has.
    const described = at('description').replace(/\s+/g, ' ') || null
    // A transfer with no note reads best as where it went, not where it came
    // from: "Needs" over "SBI Bank" on a row that says SBI Bank → Needs.
    const payee_raw = described ?? category_hint ?? to_account ?? account
    const method = described?.match(METHOD)?.[1]?.toUpperCase() ?? null
    // Only a row with nothing to call it at all is worth a look. A named
    // category is a perfectly good label — flagging all of them would put a
    // whole imported year into "Needs a look" and make the queue useless.
    const confidence = described ? 1.0 : payee_raw ? 0.8 : 0.65

    rows.push({
      txn_ref: at('ref') || null, // null → db.forInsert synthesises a stable one
      txn_date,
      txn_time: extractTime(at('date')),
      amount: hit.value,
      direction,
      payee_raw,
      category_hint,
      account,
      to_account,
      method,
      source: 'statement',
      confidence,
      needs_review: confidence < 0.7,
      raw_text,
    })
  }

  return { rows, skipped, columns, header }
}

// ── Self-check ───────────────────────────────────────────────────────────────
/** Returns the number of failures. Call from the console after touching this file. */
export function selfTest() {
  let fails = 0
  const now = new Date(2024, 8, 1)
  const check = (ok, msg) => { if (!ok) { fails++; console.assert(ok, msg) } }

  const csv = parseCSV('a,"b,c","he said ""hi""",d\r\n1,2,3,4\n')
  check(csv.length === 2, 'two rows across CRLF')
  check(csv[0][1] === 'b,c', 'comma inside quotes')
  check(csv[0][2] === 'he said "hi"', 'escaped double quote')

  const a = parseStatement('Date,Narration,Amount\n15-08-2024,"SWIGGY, Bangalore","1,00,000.50 Dr"\n', { now })
  check(a.rows[0]?.amount === 100000.5, 'Indian grouping is not 1')
  check(a.rows[0]?.txn_date === '2024-08-15', 'DD-MM-YYYY is day-first')
  check(a.rows[0]?.direction === 'debit', 'trailing Dr marker')

  const b = parseStatement('Txn Date,Particulars,Withdrawal Amt,Deposit Amt,UTR\n01/02/24,NEFT SALARY,0.00,"50,000",U123\n', { now })
  check(b.rows[0]?.direction === 'credit' && b.rows[0]?.amount === 50000, 'split debit/credit columns')
  check(b.rows[0]?.txn_ref === 'U123' && b.rows[0]?.method === 'NEFT', 'ref and method')

  const c = parseStatement('Date,Details,Amount\nnot a date,X,100\n', { now })
  check(c.rows.length === 0 && c.skipped.length === 1, 'bad date is skipped, not dropped')
  return fails
}
