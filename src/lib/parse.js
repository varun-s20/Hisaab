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
const REF_BARE = /\b(\d{12,22})\b/ // bare 12-digit UTR, common on bank SMS-style screens

export function extractRef(clean) {
  const m = clean.match(REF_LABELLED)
  if (m) return m[1]
  const bare = clean.match(REF_BARE)
  return bare ? bare[1] : null
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

export function isPersonal(payee) {
  if (!payee) return false
  const p = payee.trim()
  return UPI_HANDLE.test(p) || HUMAN_NAME.test(p)
}

// ── Dedup key ────────────────────────────────────────────────────────────────
// No ref on the screenshot? Synthesise a stable one from date+amount+payee so
// the unique index still catches a re-upload. Prefixed so it's obviously
// derived and can be found later.
export function synthRef({ txn_date, amount, payee_raw }) {
  const slug = (payee_raw ?? 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  return `syn_${txn_date ?? 'nodate'}_${amount ?? 0}_${slug}`
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
