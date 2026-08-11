// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE GETS REWRITTEN AGAINST REAL OCR OUTPUT.
//
// Run `npm run ocr` over real screenshots, read screenshots/ocr-output.txt,
// then tune the patterns below to match. The structure is right; the specific
// strings are educated guesses until they've seen your actual screenshots.
// BUILD_GUIDE.md §6.4.
// ─────────────────────────────────────────────────────────────────────────────

// Which app the screenshot came from, by distinctive strings.
const SIGNATURES = [
  { app: 'gpay', test: /google\s?pay|\bgpay\b|UPI transaction ID/i },
  { app: 'phonepe', test: /phonepe|phone\s?pe|Txn\.?\s?ID|UTR No/i },
  { app: 'paytm', test: /paytm/i },
  { app: 'bhim', test: /\bBHIM\b/i },
  { app: 'cred', test: /\bCRED\b/i },
]

export function detectApp(text) {
  return SIGNATURES.find((s) => s.test.test(text))?.app ?? 'unknown'
}

// ── Amount ───────────────────────────────────────────────────────────────────
// ₹ or Rs or INR, Indian comma grouping (1,00,000), optional paise.
// OCR reads ₹ as 3, 2, or ? often enough that the currency mark can't be
// required — hence the second, looser pass.
const AMOUNT_STRICT = /(?:₹|Rs\.?|INR)\s?([\d][\d,]*(?:\.\d{1,2})?)/i
const AMOUNT_LOOSE = /(?:^|\s)([\d]{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2})(?:\s|$)/

export function toNumber(raw) {
  if (raw == null) return null
  // Indian grouping: strip every comma BEFORE Number(). parseFloat on the raw
  // string silently reads "1,00,000" as 1. This is the 100× bug.
  const n = Number(String(raw).replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

export function extractAmount(lines) {
  // Payment screens put the amount big and near the top. Prefer the earliest
  // currency-marked number; fall back to a grouped/decimal number.
  for (const line of lines) {
    // Same guard as the loose pass below. A bank-style screen puts "Avl Bal
    // ₹12,345" above the payment, and a currency mark on the balance is not a
    // reason to trust it more than the amount actually paid.
    if (/balance|limit|cashback|reward/i.test(line)) continue
    const m = line.match(AMOUNT_STRICT)
    if (m) {
      const n = toNumber(m[1])
      if (n) return n
    }
  }
  for (const line of lines) {
    if (/balance|limit|cashback|reward/i.test(line)) continue
    const m = line.match(AMOUNT_LOOSE)
    if (m) {
      const n = toNumber(m[1])
      if (n) return n
    }
  }
  return null
}

// ── Reference / UTR ──────────────────────────────────────────────────────────
const REF_LABELLED =
  /(?:UPI transaction ID|UPI Ref(?:erence)?(?:\s?(?:ID|No\.?))?|Transaction ID|Txn\.?\s?ID|UTR(?:\s?No\.?)?|Order ID)\s*[:\-]?\s*([A-Za-z0-9]{8,25})/i
// Bare UTR, common on bank SMS-style screens. Exactly 12 digits, and not on a
// line that names an account or a card: the old 12-22 range matched account
// numbers too, and an account number is the same on every screenshot — two
// genuinely different payments would share a dedup key and the second would
// vanish as a duplicate.
const REF_BARE = /(?<!\d)(\d{12})(?!\d)/
const NOT_A_REF = /a\/c|acc(?:ount)?\s*(?:no|number|#)|card\s*(?:no|number|ending)|xxxx/i

export function extractRef(clean) {
  const m = clean.match(REF_LABELLED)
  if (m) return m[1]
  for (const line of clean.split('\n')) {
    if (NOT_A_REF.test(line)) continue
    const bare = line.match(REF_BARE)
    if (bare) return bare[1]
  }
  return null
}

// ── Direction ────────────────────────────────────────────────────────────────
const CREDIT = /received from|credited|money received|you received|added to/i
const DEBIT = /paid to|sent to|debited|payment to|you paid|paid successfully/i

export function extractDirection(clean) {
  if (CREDIT.test(clean)) return 'credit'
  if (DEBIT.test(clean)) return 'debit'
  return 'debit' // Screenshots are overwhelmingly payments.
}

// ── Payee ────────────────────────────────────────────────────────────────────
// Layout is vertical: a label line, then the name on the next line — or the
// name inline after the label. Handle both.
const PAYEE_INLINE =
  /(?:paid to|sent to|payment to|received from|money sent to|to)\s*[:\-]?\s*(.+)$/i
const PAYEE_LABEL = /^(?:paid to|sent to|payment to|received from|to|from)\s*[:\-]?\s*$/i

const NOISE =
  /^(?:completed|success(?:ful)?|transaction successful|payment successful|done|ok|share|split|help|home|banking name|upi id|to:?|from:?)$/i

function cleanName(s) {
  return s
    .replace(/[₹|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9@.\-_ ]+$/g, '')
    .trim()
}

export function extractPayee(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (PAYEE_LABEL.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() && !NOISE.test(l.trim()))
      if (next) {
        const name = cleanName(next)
        if (name.length >= 2) return name
      }
      continue
    }
    const m = line.match(PAYEE_INLINE)
    if (m) {
      const name = cleanName(m[1])
      // "to" alone matched the whole line, or the amount trailed onto it
      if (name.length >= 2 && !/^\d+$/.test(name) && !NOISE.test(name)) return name
    }
  }
  // Last resort: a bare UPI handle anywhere in the text.
  const handle = lines.join(' ').match(/\b([\w.\-]{2,}@[a-z]{3,10})\b/i)
  return handle ? handle[1] : null
}

// ── Date & time ──────────────────────────────────────────────────────────────
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const D_TEXT = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s*(\d{2,4})?\b/i
const D_TEXT_REV = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s*(\d{2,4})?\b/i
const D_NUM = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/

export function extractDate(clean, now = new Date()) {
  if (/\btoday\b/i.test(clean)) return iso(now)
  if (/\byesterday\b/i.test(clean)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    return iso(d)
  }

  let m = clean.match(D_TEXT)
  if (m) return build(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3], now)

  m = clean.match(D_TEXT_REV)
  if (m) return build(Number(m[2]), MONTHS[m[1].toLowerCase()], m[3], now)

  m = clean.match(D_NUM)
  if (m) {
    // Indian apps are DD/MM/YY. Only swap if the first number can't be a day.
    let [, a, b, y] = m
    let day = Number(a)
    let mon = Number(b) - 1
    if (day > 12 && mon > 11) return null
    if (mon > 11) {
      day = Number(b)
      mon = Number(a) - 1
    }
    return build(day, mon, y, now)
  }
  return null
}

function build(day, mon, year, now) {
  if (!(day >= 1 && day <= 31) || !(mon >= 0 && mon <= 11)) return null
  let y = year ? Number(year) : now.getFullYear()
  if (y < 100) y += 2000
  const d = new Date(y, mon, day)
  if (d.getDate() !== day || d.getMonth() !== mon) return null
  // A screenshot dated in the future is a misread year, not time travel.
  if (d.getTime() > now.getTime() + 86400000) return null
  return iso(d)
}

const TIME = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/i

export function extractTime(clean) {
  const m = clean.match(TIME)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`
}

// ── Person-to-person (local only, never hits any API) ────────────────────────
const UPI_HANDLE = /^[\w.\-]+@[a-z]{3,10}$/i
const HUMAN_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/

// Plenty of registered businesses are two or three Title-case words:
// "Eazydiner Private Limited" reads exactly like a person to the regex above,
// and calling it a transfer deletes it from every spending total. Any of these
// words settles it — a person is not a Pvt Ltd.
const NOT_A_PERSON =
  /\b(ltd|limited|pvt|private|llp|llc|inc|corp|corporation|company|enterprises|traders|industries|retail|marketplace|services|solutions|technologies|store|stores|mart|supermarket|bazaar|foodcourt|restaurant|cafe|hotel|bakery|chemist|pharmacy|medical|clinic|hospital|agency|agencies|associates|brothers|sons|centre|center)\b/i

export function isPersonal(payee) {
  if (!payee) return false
  const p = payee.trim()
  if (UPI_HANDLE.test(p)) return true
  return HUMAN_NAME.test(p) && !NOT_A_PERSON.test(p)
}

// ── Dedup key ────────────────────────────────────────────────────────────────
// No ref on the screenshot? Synthesise a stable one from date+amount+payee so
// the unique index still catches a re-upload. Prefixed so it's obviously
// derived and can be found later.
// History-list screenshots carry no reference at all, so the time is part of
// the key — without it, two ₹50 Swiggy orders on the same day collapse into one.
export function synthRef({ txn_date, txn_time, amount, payee_raw }) {
  const slug = (payee_raw ?? 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  // Seconds are kept only when the source actually had them. A parser that
  // reads "2:14 pm" off a screenshot still produces the same key it always
  // did, so re-uploading last week's screenshots is still a no-op — but a
  // manual entry that deliberately sends the clock (ManualEntry) gets a key of
  // its own, and two ₹20 chais a minute apart stay two rows.
  const t = txn_time ? txn_time.slice(0, 8).replace(/:/g, '') : ''
  return `syn_${txn_date ?? 'nodate'}${t ? `T${t}` : ''}_${amount ?? 0}_${slug}`
}

// ── The parser ───────────────────────────────────────────────────────────────
export function parse(text, now = new Date()) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const clean = lines.join(' ').replace(/\s+/g, ' ')

  const app = detectApp(clean)
  const amount = extractAmount(lines)
  const txn_ref = extractRef(clean)
  const direction = extractDirection(clean)
  const payee_raw = extractPayee(lines)
  const txn_date = extractDate(clean, now)
  const txn_time = extractTime(clean)

  // Confidence drives whether this surfaces to the user at all.
  let confidence = 1.0
  if (app === 'unknown') confidence -= 0.4
  if (!amount) confidence -= 0.6
  if (!payee_raw) confidence -= 0.3
  if (!txn_ref) confidence -= 0.1
  if (!txn_date) confidence -= 0.2
  confidence = Math.max(0, Math.round(confidence * 100) / 100)

  return {
    app,
    amount,
    direction,
    payee_raw,
    txn_date,
    txn_time,
    txn_ref,
    method: app === 'unknown' ? null : app,
    source: 'screenshot',
    confidence,
    needs_review: confidence < 0.7,
    raw_text: text,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY-LIST SCREENSHOTS
//
// Written against real OCR output (screenshots/ocr-output.txt, 11 Aug 2026).
// The real screenshots are not single-payment receipts — they're the in-app
// transaction *history* screens, roughly seven transactions per shot:
//
//   Paytm    & Kunafa Mahal -394               name + amount
//            Paid Yesterday, 11:01 PM From A   verb, date, time, account
//            @ Food                            Paytm's own category
//
//   GPay     (E Eazy Diner Private Limited 3837
//            7 August
//
//   PhonePe  Received from
//            ¥ Dad +%25,000
//            31 Jul Credited to Paytm
//
// That's strictly better than receipts: one tap yields seven rows instead of
// one, the list contains transactions you never thought to screenshot, and
// Paytm hands over a category for free — which skips the AI entirely for most
// rows. Receipts still work; `parseScreenshot` falls back to `parse` when it
// finds no list anchors.
// ─────────────────────────────────────────────────────────────────────────────

// Matched against the *chrome* of the history screen, never the app's name —
// a single-payment receipt says "Google Pay" too, and must fall through to the
// receipt parser rather than be read as a one-row list.
const LIST_APPS = [
  { app: 'gpay', test: /search transactions|payment method/i },
  { app: 'phonepe', test: /my statements|credited to|debited from/i },
  { app: 'paytm', test: /payment history|balance\s?&?\s?history|total spent/i },
]

function detectListApp(text) {
  return LIST_APPS.find((a) => a.test.test(text))?.app ?? null
}

// Paytm: "Paid Today, 07:18 AM", "Sent on 04 Aug, 01:31 PM"
const ANCHOR =
  /^[-\s]*(Paid|Sent|Received)\s+(?:(Today|Yesterday)|on\s+(\d{1,2})\s+([A-Za-z]{3,9}))\s*,?\s*(\d{1,2}:\d{2})?\s*(AM|PM)?/i

// GPay and PhonePe: a bare date line — "9 August", "31 Jul Credited to Paytm".
// Up to four characters of avatar junk may precede it ("W@W 9 August").
const DATE_ANCHOR = /^.{0,4}?(\d{1,2})\s+([A-Za-z]{3,9})\b/

// THE RUPEE SIGN IS ONE CHARACTER, ALWAYS.
//
// Tesseract's `eng` model has no ₹ in its charset, so it substitutes the
// nearest shape — %, 3, 2, 7, ¥, ©, S — but it always emits exactly one
// character for it, immediately after any sign. Verified character-by-character
// against the bounding boxes of all three apps:
//
//   -394      → ₹94        (Paytm, glyph read as 3)
//   3837      → ₹837       (GPay debit, no sign, glyph read as 3)
//   21136     → ₹1,136     (GPay, glyph read as 2)
//   +%25,000  → ₹25,000    (PhonePe, glyph read as %)
//   71,650    → ₹1,650     (PhonePe, glyph read as 7)
//
// So: drop one character, whatever it is. Do not try to be clever about which
// characters "look like" a rupee sign — that list is unbounded, and treating
// the glyph as a digit multiplies the amount by ten.
//
// The glyph class excludes + and − so the sign can't be mistaken for it. Without
// that, "+3580" matches with glyph='+' and amount=3580 — a credit of ₹580 read
// as a debit of ₹3,580, wrong twice over.
const LIST_AMOUNT = /([-+])?\s*([^+\-\s])((?:\d[\d,]*)(?:\.\d{1,2})?)\s*$/

// Paytm's own labels. Local, free, and better than anything an LLM would guess.
const PAYTM_CATEGORY = {
  food: 'Food & Dining',
  groceries: 'Groceries',
  taxi: 'Transport',
  travel: 'Transport',
  fuel: 'Transport',
  entertainment: 'Entertainment',
  shopping: 'Shopping',
  medical: 'Health',
  health: 'Health',
  'bill payments': 'Bills & Utilities',
  recharge: 'Bills & Utilities',
  utilities: 'Bills & Utilities',
  rent: 'Rent',
  education: 'Education',
  'personal care': 'Personal Care',
  'money transfer': 'Transfers',
  'money received': 'Transfers',
  financial: 'Transfers',
  investment: 'Transfers',
  insurance: 'Transfers',
  miscellaneous: 'Other',
  others: 'Other',
  other: 'Other',
}

const MONTH_HEADER =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\b/i

/**
 * Every app prefixes each row with an avatar, and OCR renders it as junk:
 * "IC", "gr)", "(E", "¥", "W@W". Strip a leading token when it's initials
 * (1–2 letters) or contains punctuation — but keep real short words, so
 * "The Coffee Bean" survives while "Ms Shyam Departmental Store" loses its
 * two-letter prefix.
 */
function stripAvatar(name) {
  let out = String(name ?? '').replace(/^[^A-Za-z0-9]+/, '')
  const token = out.match(/^(\S{1,3})\s+(?=[A-Za-z0-9])/)
  if (token && (/^[A-Za-z]{1,2}$/.test(token[1]) || /[^A-Za-z0-9]/.test(token[1]))) {
    out = out.slice(token[0].length)
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/**
 * The category line arrives with an icon glyph in front, and the glyph OCRs as
 * anything: "@ Food", "3 Money Transfer", "[i Shopping", "«=, Taxi".
 * Strip everything ahead of the label, including a stray one- or two-letter
 * fragment of the icon.
 */
function categoryLabel(line) {
  return String(line ?? '')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/^[A-Za-z]{1,2}\s+(?=[A-Z])/, '')
    .trim()
    .toLowerCase()
}

// Wrapped mandate copy, not part of the merchant name.
const NOT_NAME = /^(?:[-~\s]*automatic payment|payment(?:\s+of\b|$)|setup$|\d[\d,]*\s*setup)/i

// A trailing sign and at most one more character, with no number after it:
// the amount the OCR lost. Only applied when nothing matched LIST_AMOUNT, so a
// real amount is never eaten by this.
const BROKEN_AMOUNT = /[-+]\s*.?\s*$/

// A bare year on its own line — GPay stacks "2026" above the month name.
const YEAR_LINE = /^\W*(20\d{2})\W*$/

/**
 * Match the amount at the end of a row.
 *
 * Rejects a line that is nothing *but* a number with no sign — that's a year
 * header or a month total, not a payment. A real row always has the merchant
 * name to the left of the amount, or an explicit + / −.
 */
function matchAmount(line) {
  const m = line.match(LIST_AMOUNT)
  if (!m) return null
  if (m.index === 0 && !m[1]) return null
  return m
}

/** The verb sits on the amount line (Paytm) or the line above it (PhonePe). */
const VERB = /(received from|credited|money received|paid to|sent to|debited|paid|sent)/i

export function parseHistory(text, now = new Date()) {
  const app = detectListApp(text) ?? 'unknown'
  const paytm = app === 'paytm'
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // Year context. Paytm states it once ("August 2026"); GPay and PhonePe repeat
  // it per month section, so it has to be tracked as we walk down the screen.
  let year = Number(text.match(MONTH_HEADER)?.[2]) || null

  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const yearOnly = lines[i].match(YEAR_LINE)
    if (yearOnly) year = Number(yearOnly[1])
    const monthHeader = lines[i].match(MONTH_HEADER)
    if (monthHeader) year = Number(monthHeader[2])

    // Anchor: the line carrying this row's date.
    const a = paytm ? lines[i].match(ANCHOR) : null
    const b = paytm ? null : matchDateLine(lines[i])
    if (!a && !b) continue

    // Walk back to the line carrying the amount — that's the merchant line.
    let head = -1
    let fallbackHead = -1
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (paytm ? ANCHOR.test(lines[j]) : matchDateLine(lines[j])) break // previous row
      // A month or year header. "August 2026" would otherwise read as ₹26, and
      // a month total as a payment.
      if (YEAR_LINE.test(lines[j]) || MONTH_HEADER.test(lines[j])) break
      if (matchAmount(lines[j])) {
        head = j
        break
      }
      // The previous transaction's category label — stop, or its name bleeds
      // into this row.
      if (PAYTM_CATEGORY[categoryLabel(lines[j])]) break
      if (fallbackHead === -1 && !NOT_NAME.test(lines[j]) && !VERB.test(lines[j])) fallbackHead = j
    }

    // No amount on any line above? The OCR mangled it — a mandate line reading
    // "-3" with the digits lost. Emit the row anyway with a low confidence so
    // it surfaces in review. Dropping it silently is how a ledger goes wrong
    // without anyone noticing.
    if (head === -1 && fallbackHead === -1) continue

    const m = head === -1 ? null : matchAmount(lines[head])
    const amount = m ? toNumber(m[3]) : null // m[2] is the rupee glyph, discarded

    const nameStart = head === -1 ? fallbackHead : head
    let payee_raw = stripAvatar(
      m ? lines[head].slice(0, m.index) : lines[fallbackHead].replace(BROKEN_AMOUNT, ''),
    )
    for (let j = nameStart + 1; j < i; j++) {
      if (NOT_NAME.test(lines[j])) continue
      const extra = stripAvatar(lines[j])
      if (extra.length >= 2) payee_raw = `${payee_raw} ${extra}`.trim()
    }

    // Direction: the sign wins, then the verb. GPay writes debits with no sign
    // at all, so absence of a sign is not evidence of anything.
    const verbLine = a ? lines[i] : (lines[nameStart - 1] ?? '') + ' ' + lines[nameStart]
    const verb = verbLine.match(VERB)?.[1]?.toLowerCase() ?? ''
    const credit = m?.[1] === '+' || /received|credited/.test(verb)

    const txn_date = a
      ? a[2]
        ? extractDate(a[2], now)
        : listDate(Number(a[3]), a[4], year, now)
      : listDate(Number(b[1]), b[2], year, now)
    const txn_time = a?.[5] ? extractTime(`${a[5]} ${a[6] ?? ''}`) : null

    // Paytm's label sits on the line after the date, prefixed with an icon.
    const hint = paytm ? (PAYTM_CATEGORY[categoryLabel(lines[i + 1])] ?? null) : null

    // "Credited to Paytm" / "Debited from HDFC" — which pocket it moved through.
    const account = lines[i].match(/(?:credited to|debited from)\s+([A-Za-z]+)/i)?.[1] ?? null

    let confidence = 1.0
    if (!amount) confidence -= 0.6
    if (!payee_raw) confidence -= 0.3
    if (!txn_date) confidence -= 0.3
    confidence = Math.max(0, Math.round(confidence * 100) / 100)

    rows.push({
      app,
      amount,
      direction: credit ? 'credit' : 'debit',
      payee_raw: payee_raw || null,
      txn_date,
      txn_time,
      txn_ref: null, // the list view shows none; db.js synthesises one
      category_hint: hint,
      method: app === 'unknown' ? null : app,
      account,
      source: 'screenshot',
      confidence,
      needs_review: confidence < 0.7,
      raw_text: lines.slice(nameStart, i + 2).join('\n'),
    })
  }
  return rows
}

/** "9 August", "31 Jul Credited to Paytm" — GPay and PhonePe row dates. */
function matchDateLine(line) {
  const m = line.match(DATE_ANCHOR)
  if (!m) return null
  if (MONTHS[m[2].slice(0, 3).toLowerCase()] === undefined) return null
  return m
}

/** A day and a month name with no year — take the year from the screen. */
function listDate(day, monthName, headerYear, now) {
  const mon = MONTHS[monthName.slice(0, 3).toLowerCase()]
  if (mon === undefined) return null
  const year = headerYear ?? now.getFullYear()
  let d = new Date(year, mon, day)
  // A list dated after today means the year rolled over (December rows under a
  // January header), not a payment from the future.
  if (d.getTime() > now.getTime() + 86400000) d = new Date(year - 1, mon, day)
  if (d.getDate() !== day || d.getMonth() !== mon) return null
  return iso(d)
}

/**
 * One screenshot in, one or more transactions out.
 * History screens yield many rows; a single receipt yields one.
 */
export function parseScreenshot(text, now = new Date()) {
  if (detectListApp(text)) {
    const rows = parseHistory(text, now)
    // A list row whose amount the OCR lost still belongs to the list — it goes
    // to review. Only a screen with no rows at all is worth re-reading as a
    // receipt.
    if (rows.length > 0) return rows
  }
  return [parse(text, now)]
}
