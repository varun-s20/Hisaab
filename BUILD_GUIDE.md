# Paisa — Build Guide

A privacy-first, zero-cost UPI expense tracker PWA.
Upload screenshots, get a real ledger. No manual entry.

---

## 0. How to use this guide

**If you are an AI assistant picking this up: read this section first.**

This guide is written to be handed to Claude, Cursor, or any coding assistant one phase at a time. It is deliberately opinionated — the decisions here were argued through and the reasoning lives in `HANDOFF.md`.

**Ask questions before writing code.** If anything below is ambiguous, contradicts what the user tells you, or depends on something not specified (their bank, their spending patterns, whether they want a feature at all), **stop and ask**. Do not guess and build. Specifically, ask when:

- The user's actual screenshot formats don't match the parser assumptions in Phase 1
- A library version has changed enough that the code here won't run
- The user wants a feature that would break the "no data leaves the device" rule
- You're about to add a confirmation step, a form, or a button the user has to press regularly

That last one matters most. The core design rule of this app is **the app only speaks when it's genuinely unsure.** Every UI element you add should be justified against that.

**Build in phase order.** Phase 1 must work end-to-end before Phase 2 starts. Do not build the dashboard before the parser works. The user will lose weeks if the foundation is wrong.

---

## 1. What this is

An Android-first PWA that turns payment app screenshots into a structured expense ledger, with as close to zero user input as browser security allows.

**The flow:** Open app → tap once to select the day's screenshots → app OCRs them on-device → parses amount, merchant, date, reference → categorises → saves → shows a one-line summary. The user does not confirm anything unless the app genuinely couldn't read something.

### Non-negotiable principles

1. **The image never leaves the device.** OCR runs in-browser. Screenshots are not uploaded and not stored.
2. **The LLM is a last resort, not a first step.** Deterministic parsing handles the common case. AI is called only for unknown merchants, and receives only a merchant name string — never an amount, date, image, or UPI ID.
3. **No confirmation queues.** High-confidence transactions save silently. Only genuine failures surface.
4. **Free to run.** Every component sits on a free tier. If a design choice forces a paid tier, that's a signal the design is wrong.
5. **Transfers are not expenses.** Credit card payments, self-transfers, and money lent to friends live in the ledger but never appear in spending totals.

### What this is NOT

- Not a budgeting app with envelopes and goals (maybe later)
- Not multi-user (schema supports it, UI doesn't)
- Not iOS-optimised (works, but the share-target and some ergonomics are Android-only)

---

## 2. Architecture

```
┌─────────────────── YOUR PHONE ────────────────────┐
│                                                   │
│  Screenshots  ──►  PWA (installed to home screen) │
│                     │                             │
│                     ├─ Tesseract.js (WASM)        │
│                     │    image → raw text         │
│                     │    IMAGE DISCARDED HERE     │
│                     │                             │
│                     ├─ Parser (regex per app)     │
│                     │    text → {amount, payee,   │
│                     │            date, ref}       │
│                     │                             │
│                     └─ Merchant map (cached)      │
│                          payee → category         │
└───────────────────────────┬───────────────────────┘
                            │ only structured rows
                            ▼
                 ┌──────────────────────┐
                 │  Supabase (Postgres) │
                 │  transactions        │
                 │  merchant_map        │
                 └──────────┬───────────┘
                            │
              unknown merchant strings only
                            ▼
                 ┌──────────────────────┐
                 │ Serverless function  │
                 │ (Vercel /api)        │
                 │   → Gemini free tier │
                 └──────────────────────┘
```

**What crosses the network:**

| To Supabase | To Gemini |
|---|---|
| date, amount, merchant, category, type, method, txn_ref | a merchant name string, nothing else |

**What never crosses the network:** the screenshot image, your balance, your UPI ID, your name, your bank account number.

---

## 3. Stack

| Layer | Choice | Why | Free tier catch |
|---|---|---|---|
| Framework | React + Vite | Fast, well-supported, AI writes it well | — |
| PWA | `vite-plugin-pwa` | Handles manifest + service worker | — |
| OCR | `tesseract.js` | Runs on-device, no API, no cost | ~10MB language data on first run — must be cached |
| DB | Supabase (Postgres) | Free tier, real SQL, RLS, auth ready | Pauses after ~7 days inactivity; resumes slowly |
| AI | Gemini API free tier | Genuinely free, no card needed | Quotas change; free tier inputs may be used for training |
| Hosting | Vercel (or Cloudflare Pages) | Free tier + custom domain + serverless functions | Cold starts on the API function (~1s, irrelevant here) |
| Charts | Recharts or uPlot | Recharts is easier; uPlot is lighter | — |

**Why not Sheets:** API quotas, latency, no real querying. Postgres is strictly better once you're building an app.

**Why not Telegram / a separate bot:** the user explicitly wants one surface. Tesseract is a library inside the app, not a separate product — this distinction was a point of confusion and is worth restating to the user if it comes up.

---

## 4. Prerequisites

Accounts to create (all free, ~15 minutes):

1. **Supabase** — supabase.com, create a project. Note the project URL and `anon` key.
2. **Google AI Studio** — aistudio.google.com, create an API key. **Check the live rate limits shown for your project** — published numbers in blog posts are unreliable and quotas have been cut before.
3. **Vercel** — vercel.com, connect to a GitHub repo.
4. **Domain** — user already owns two. Point a subdomain (e.g. `paisa.yourdomain.com`) at Vercel via CNAME.

Local tooling: Node 20+, npm, git.

---

## 5. Data model

Run this in the Supabase SQL editor.

```sql
-- Transactions: one row per payment
create table transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),

  txn_ref       text,                    -- UPI reference; dedup key
  txn_date      date not null,
  txn_time      time,

  amount        numeric(12,2) not null,  -- always positive
  direction     text not null check (direction in ('debit','credit')),
  type          text not null default 'expense'
                check (type in ('expense','income','transfer','refund','lent','repaid')),

  payee_raw     text not null,           -- exactly as OCR'd
  payee_clean   text,                    -- after merchant map
  category      text,
  subcategory   text,

  method        text,                    -- gpay | phonepe | paytm | card | cash | netbanking
  account       text,                    -- which bank/card, if known

  source        text not null default 'screenshot'
                check (source in ('screenshot','statement','manual')),
  confidence    numeric(3,2) default 1.0,
  needs_review  boolean default false,
  note          text,

  raw_text      text,                    -- OCR output, for debugging parsers
  created_at    timestamptz default now()
);

-- Dedup: the same UPI ref can only exist once per user
create unique index txn_ref_unique
  on transactions (user_id, txn_ref)
  where txn_ref is not null;

create index txn_date_idx on transactions (user_id, txn_date desc);

-- Merchant map: the learned asset. This is the most valuable table.
create table merchant_map (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),
  payee_pattern text not null,            -- normalised payee string
  payee_clean   text not null,            -- "Swiggy"
  category      text not null,
  default_type  text default 'expense',
  hit_count     int default 1,
  source        text default 'user',      -- user | ai | seed
  created_at    timestamptz default now(),
  unique (user_id, payee_pattern)
);

-- Row level security: nobody sees anyone else's money
alter table transactions enable row level security;
alter table merchant_map enable row level security;

create policy "own rows" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own map" on merchant_map
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### Field notes

**`type` is the field that makes this correct.** All spending charts must filter `type = 'expense'`. A credit card bill paid via GPay is `transfer` — the actual expenses already exist as card transactions. Splitting a bill and getting paid back is `lent` then `repaid`. Without this, totals are fiction.

**`txn_ref` is the dedup key.** Every UPI screenshot shows a reference/UTR number. The unique index means re-uploading the same screenshot is a silent no-op — which is exactly what you want when the user batch-uploads a folder that overlaps with yesterday's.

**`raw_text` earns its storage.** When a parser fails you need the OCR output to fix it. Drop this column once the parsers are stable.

### Starter categories (India-tuned)

```
Food & Dining · Groceries · Transport · Shopping · Bills & Utilities
Rent · Health · Entertainment · Education · Personal Care
Household Help · Transfers · Income · Other
```

Fourteen. Resist adding more — categories you don't use become noise. `Household Help`, `Rent`, and `Transport` (autos, cabs, fuel, metro) are first-class here because lumping them into "Other" is what makes generic trackers useless in India.

---

## 6. Phase 1 — the machine works

**Goal:** a screenshot becomes a correct database row with no thinking from the user. No categories, no charts, no polish.

**Do not skip to Phase 2. The parsers are the whole project.**

### 6.1 Step zero: the OCR spike

Before writing any app, build a single HTML file that OCRs an image and dumps the raw text on screen. Open it on the actual phone. Feed it real GPay, PhonePe, and Paytm screenshots.

```html
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<input type="file" accept="image/*" multiple id="f">
<pre id="out" style="white-space:pre-wrap;font:13px monospace"></pre>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js"></script>
<script>
document.getElementById('f').onchange = async (e) => {
  const out = document.getElementById('out');
  const worker = await Tesseract.createWorker('eng');
  for (const file of e.target.files) {
    out.textContent += `\n===== ${file.name} =====\n`;
    const { data } = await worker.recognize(file);
    out.textContent += data.text + '\n';
  }
  await worker.terminate();
};
</script>
```

**This output is the specification for every parser you write.** Do not write regexes against imagined layouts. Get the real strings first.

Expected: payment screenshots are crisp digital text at high contrast — near-ideal OCR conditions. Accuracy should be excellent; speed will be a couple of seconds per image on a mid-range phone, which is fine for batch processing.

### 6.2 Project setup

```bash
npm create vite@latest paisa -- --template react
cd paisa
npm install tesseract.js @supabase/supabase-js
npm install -D vite-plugin-pwa
```

`vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Paisa',
        short_name: 'Paisa',
        start_url: '/',
        display: 'standalone',
        background_color: '#0E1012',
        theme_color: '#0E1012',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        // Tesseract's WASM + language data are large; cache them or
        // every cold start re-downloads ~10MB and feels broken.
        globPatterns: ['**/*.{js,css,html,png,svg,wasm}'],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        runtimeCaching: [{
          urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
          handler: 'CacheFirst',
          options: { cacheName: 'tesseract-assets', expiration: { maxEntries: 20 } }
        }]
      }
    })
  ]
})
```

`.env.local`:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

The Gemini key does **not** go here — it goes in Vercel's server-side env vars (section 7.3). A key in a `VITE_` variable ships to the browser and will be scraped.

### 6.3 The OCR module

`src/lib/ocr.js`:

```js
import { createWorker } from 'tesseract.js'

let workerPromise = null

// One worker, reused. Creating one per image is the classic performance bug.
function getWorker() {
  if (!workerPromise) workerPromise = createWorker('eng')
  return workerPromise
}

export async function readImage(file) {
  const worker = await getWorker()
  const { data } = await worker.recognize(file)
  return data.text
  // Note: `file` goes out of scope here and is never uploaded or persisted.
  // This is the privacy guarantee. Do not add a storage call.
}

export async function readBatch(files, onProgress) {
  const results = []
  for (let i = 0; i < files.length; i++) {
    results.push(await readImage(files[i]))
    onProgress?.(i + 1, files.length)
  }
  return results
}
```

### 6.4 The parser

`src/lib/parse.js` — **this is the file you will rewrite against real OCR output.** The structure below is correct; the specific patterns are placeholders.

```js
// Detect which app the screenshot came from by distinctive strings.
// Fill these in from your Phase 1 spike output.
const SIGNATURES = [
  { app: 'gpay',    test: /Google Pay|UPI transaction ID/i },
  { app: 'phonepe', test: /PhonePe|Txn\.? ID/i },
  { app: 'paytm',   test: /Paytm|Paytm UPI/i },
]

function detectApp(text) {
  return SIGNATURES.find(s => s.test.test(text))?.app ?? 'unknown'
}

// Amount: ₹ or Rs, optional Indian comma grouping, optional paise.
const AMOUNT = /(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/

// UPI reference: 12-digit UTR is the common case, but formats vary by app.
const REF = /(?:UPI transaction ID|Txn\.? ID|UTR|Transaction ID)\D{0,10}(\w{8,22})/i

// Direction: most apps say "Paid to X" vs "Received from X"
const DIRECTION = [
  { dir: 'debit',  test: /paid to|sent to|debited|payment to/i },
  { dir: 'credit', test: /received from|credited|money received/i },
]

export function parse(text) {
  const app = detectApp(text)
  const clean = text.replace(/\s+/g, ' ')

  const amountMatch = clean.match(AMOUNT)
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null

  const refMatch = clean.match(REF)
  const txn_ref = refMatch?.[1] ?? null

  const direction = DIRECTION.find(d => d.test.test(clean))?.dir ?? 'debit'

  const payee_raw = extractPayee(clean, app)   // app-specific, write per layout
  const txn_date  = extractDate(clean)          // handle "12 Aug 2026", "12/08/26", "Today"

  // Confidence drives whether this surfaces to the user at all.
  let confidence = 1.0
  if (app === 'unknown') confidence -= 0.4
  if (!amount)           confidence -= 0.6
  if (!payee_raw)        confidence -= 0.3
  if (!txn_ref)          confidence -= 0.1
  if (!txn_date)         confidence -= 0.2
  confidence = Math.max(0, confidence)

  return {
    app, amount, direction, payee_raw, txn_date, txn_ref,
    method: app,
    confidence,
    needs_review: confidence < 0.7,
    raw_text: text,
  }
}
```

**Confidence thresholds — the rule that makes this an agent and not a form:**

| Confidence | Behaviour |
|---|---|
| ≥ 0.7 | Saved silently. User never sees it. |
| 0.4 – 0.7 | Saved, flagged `needs_review`. Appears in the weekly cleanup screen, not now. |
| < 0.4 | Surfaced immediately — the app genuinely couldn't read it. |

Tune these numbers after two weeks of real use. If the user is being interrupted more than once or twice a week, the thresholds are too tight or the parsers need work — fix the parser, don't just raise the threshold.

### 6.5 Person-to-person detection (runs locally, never hits the API)

```js
// Bare UPI handles and human-looking names are personal transfers.
// These must never be sent to any external API.
const UPI_HANDLE = /^[\w.\-]+@[a-z]{3,10}$/i
const HUMAN_NAME = /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/

export function isPersonal(payee) {
  return UPI_HANDLE.test(payee.trim()) || HUMAN_NAME.test(payee.trim())
}
```

If `isPersonal` returns true → category `Transfers`, type `transfer`, no API call, ever. Your friends' names stay on your phone.

### 6.6 The Phase 1 screen

One screen. One button. A summary.

```
┌─────────────────────────────┐
│                             │
│         ₹ 4,320             │
│      logged today           │
│                             │
│   ┌───────────────────┐     │
│   │  Add screenshots  │     │  ← multi-select, opens gallery
│   └───────────────────┘     │
│                             │
│   18 saved · 2 need a look  │  ← tappable only if >0
│                             │
└─────────────────────────────┘
```

**Honest constraint:** the app cannot auto-open the file picker on launch — browsers require a user gesture. So "Route A" is genuinely one tap, not zero. Everything after that tap is automatic. True zero-touch requires the Phase 3 Drive watcher.

---

## 7. Phase 2 — it gets smart

### 7.1 Categorisation cascade

For each parsed transaction, in order — stop at the first hit:

1. **Personal check** (local regex) → `Transfers`. No network.
2. **Merchant map lookup** (Supabase, cached in memory on app load) → category. No AI.
3. **Seed rules** (a hardcoded list: `SWIGGY|ZOMATO|BLINKIT|ZEPTO|BIGBASKET|UBER|OLA|RAPIDO|IRCTC|JIO|AIRTEL...`) → category. No AI.
4. **Gemini** — only now, and only the merchant string.

After ~6 weeks, tier 4 fires a handful of times a month. Expect to use roughly 2% of the free quota.

### 7.2 Batch the AI call

Never call Gemini per transaction. Collect unknown merchants across the whole upload, send one request:

```
Input:  ["BHARATPE09283746", "MSWIPE*CAFE COFFEE", "PAYTM-QR-38271"]
Output: [{"merchant":"BHARATPE09283746","clean":"Local merchant","category":"Other"}, ...]
```

### 7.3 The serverless function

`api/categorise.js` (Vercel):

```js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { merchants } = req.body
  if (!Array.isArray(merchants) || merchants.length === 0 || merchants.length > 50) {
    return res.status(400).json({ error: 'send 1-50 merchant strings' })
  }

  // Guard: this endpoint accepts merchant strings only.
  // If you ever find yourself adding amount/date/image here, stop —
  // that breaks the privacy guarantee this whole app is built on.

  const CATEGORIES = ['Food & Dining','Groceries','Transport','Shopping',
    'Bills & Utilities','Rent','Health','Entertainment','Education',
    'Personal Care','Household Help','Transfers','Income','Other']

  const prompt = `You classify Indian merchant name strings from UPI payments into categories.

Categories: ${CATEGORIES.join(', ')}

Rules:
- Return ONLY a JSON array, no markdown fences, no commentary.
- One object per input, same order: {"merchant": <input>, "clean": <readable name>, "category": <one of the categories>}
- If the string is a payment gateway code with no recognisable brand (BHARATPE..., PAYTM-QR-...), use clean:"Local merchant" and category:"Other".
- If it looks like a person's name, category must be "Transfers".
- Never invent a brand that isn't clearly present in the string.

Input: ${JSON.stringify(merchants)}`

  // Check current model IDs in AI Studio — they change.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    })
    const data = await r.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
    return res.status(200).json({ results: parsed })
  } catch (e) {
    // Fail soft: unknown merchants just stay uncategorised and get
    // picked up in the weekly cleanup. Never block a save on the AI.
    return res.status(200).json({ results: [] })
  }
}
```

Set `GEMINI_API_KEY` in Vercel project settings → Environment Variables. Server-side only.

### 7.4 Learning from corrections

Every time the user changes a category, upsert into `merchant_map` with `source: 'user'` and increment `hit_count`. User corrections always outrank AI guesses — never let the AI overwrite a `source: 'user'` row.

### 7.5 The weekly cleanup screen

Once a week, one screen, only the new merchants:

```
Teach me 3 things

BHARATPE09283746  →  [Food & Dining ▾]
MSWIPE*CAFE       →  [Food & Dining ▾]
UPI/AXIS/4471     →  [Other ▾]

              [ Save ]
```

This is the **only** recurring input the app ever asks for, and it shrinks to nothing over time.

---

## 8. Phase 3 — it disappears

### 8.1 Charts that change behaviour

Skip pie charts. Build:

1. **Month-to-date vs same day last month** — two lines. Instantly answers "am I running hot?"
2. **Projected month-end** — "at this pace, ₹41,300." The single most behaviour-changing number.
3. **Category bars with last-month ghost** — not where money went, but what *moved*.
4. **Top merchants by frequency, not amount** — surfaces the ₹200 × 22 habits.
5. **Daily strip** — 30 hairline bars. Weekend patterns visible in two seconds.
6. **Unusual flag** — anything >2× the median for its category.

All charts filter `type = 'expense'`.

### 8.2 Statement reconciliation (the completeness fix)

Screenshots alone catch maybe 70% of transactions. Once a month:

1. Export the statement from GPay/PhonePe/Paytm and the bank (CSV or PDF)
2. Drop it into the app
3. It imports everything, skips existing `txn_ref`s, reports: *"Added 34 missed transactions worth ₹11,240. 12 need categories."*

**This step is what makes the ledger true rather than indicative.** 15 minutes a month. Without it, the user will trust numbers that are 30% short.

### 8.3 True zero-touch ingest

Phone already backs up screenshots to Google Photos/Drive. A scheduled function (Vercel Cron, or GitHub Actions on a schedule — both free) watches the folder, classifies "is this a payment screenshot?", processes matches, ignores the rest.

**Only build this after parsers are proven.** Auto-committing rows nobody looks at means silently accumulating garbage.

Note this path *does* mean images pass through a server, which relaxes the privacy guarantee. Flag that trade-off to the user before building it.

### 8.4 Reminders

**v1: a phone alarm at 9pm labelled "Log spends."** Fifteen seconds to set up, unbreakable, free.

**Later:** Web Push via service worker + VAPID keys, triggered by a free cron service. Worth it only once the Drive watcher exists, because then the notification can carry a count — *"6 unlogged screenshots"* reads completely differently from a generic nag.

---

## 9. Design direction

Not a spec, a direction. Deviate with reason.

**Context that should drive every choice:** this is opened once a day, at night, one-handed, for under two minutes. It is a ledger, not a dashboard.

**Palette** — cool ink, warm money. Deliberately not the default dark-with-acid-green.

```
--ink:        #0E1012   /* page */
--surface:    #181B1E   /* cards, rows */
--rule:       #262A2E   /* hairlines */
--text:       #E8E6E1
--muted:      #8A8F94
--out:        #E8A33D   /* debits — warm gold, reads as currency */
--in:         #6FB3A0   /* credits — cool, deliberately quieter than out */
--alert:      #D9634F   /* unusual / needs review only */
```

**Typography.** Amounts get **tabular numerals** — non-negotiable, columns of rupee figures that don't align look amateur. Set the `₹` a size smaller and slightly raised. Body in a plain grotesque; numbers in a tabular-figure face (Inter with `font-variant-numeric: tabular-nums` is enough).

**Signature element:** the **day strip** — 30 hairline vertical bars across the top, one per day of the month, height proportional to spend, current day marked. It's the whole month at a glance and doubles as navigation. This is the one thing to spend design effort on; keep everything else quiet.

**Structure:** the transaction list is a ledger — hairline rules, merchant left, amount right-aligned in tabular figures, category as a small coloured dot rather than a badge. No cards, no shadows, no rounded chunky containers.

**Copy rules:** the app never apologises and never nags. Empty state is an invitation: *"Nothing logged today."* Not: *"You haven't added any transactions yet!"* Failure states say what happened and what to do: *"Couldn't read the amount on 2 screenshots. Tap to enter them."*

---

## 10. Deployment

```bash
git init && git add . && git commit -m "init"
# push to GitHub, then import the repo in Vercel
```

In Vercel project settings:

- **Environment variables:** `GEMINI_API_KEY` (server-side), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- **Domains:** add `paisa.yourdomain.com`, set the CNAME at your registrar as instructed

**Install on the phone:** open the URL in Chrome on Android → menu → *Add to Home screen*. It gets its own icon and launches full-screen with no browser chrome.

**Verify after install:**
- Airplane mode → app still opens (service worker cached)
- First OCR after a fresh install completes without a 10MB stall
- A duplicate screenshot upload creates no second row
- Nothing appears in Supabase Storage (there should be no bucket at all)

---

## 11. Daily use

1. Pay for things through the day, screenshot as you already do
2. 9pm alarm → open Paisa → tap *Add screenshots* → multi-select the day's
3. Watch the count tick up, see the total
4. Ignore it unless something says "needs a look"
5. Once a week, 30 seconds on the *Teach me* screen
6. Once a month, drop in the statement export

Target: under two minutes a day, dropping toward zero as the merchant map fills.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| First OCR hangs ~30s | Tesseract downloading language data | Confirm workbox is caching CDN assets; consider bundling `eng.traineddata` locally |
| Amounts wrong by 100× | Comma stripped as decimal | Indian grouping: `1,00,000` — strip commas before `Number()`, never `parseFloat` on the raw string |
| Duplicate rows | `txn_ref` not parsed for that app | Check the REF regex against that app's real output; if the app genuinely has no ref, hash `date+amount+payee` as a fallback key |
| Supabase 500s after a break | Free tier project paused | Open the Supabase dashboard to resume; expect a slow first query |
| Gemini returns 429 | Free quota hit or project tier changed | Check live limits in AI Studio; the app should already fail soft here |
| Every transaction needs review | Parser broken for that app | Do not raise the confidence threshold. Fix the regex against `raw_text` rows |

---

## 13. Open decisions — ask the user

These were deliberately deferred. Ask before assuming:

1. **Auth** — single-user with a hardcoded ID is simplest for v1. Supabase magic-link auth is ~30 min of work and makes the schema honest. Which?
2. **iPhone** — Android-only for now. Does the second phone need to work, and when?
3. **Credit cards** — card spends don't produce UPI screenshots. Statement import only, or something else?
4. **Multi-account** — does the user pay from more than one bank/UPI app in a way they'd want separated?
5. **Cash** — how much of their spending is cash? Determines how important the manual quick-entry field is.
6. **Historical import** — start from today, or backfill the last 6 months from statements?
7. **The Drive watcher trade-off** — zero-touch requires images passing through a server. Acceptable?

---

## 14. If this becomes a product

The path from personal tool to sellable, roughly in order of difficulty:

1. **Multi-tenancy** — RLS is already there; add real auth and onboarding
2. **The merchant map becomes the moat** — a shared, anonymised seed map means new users get 80% coverage on day one instead of six weeks. This is the single most defensible asset here.
3. **Reliability** — error visibility, so users know when something failed without you telling them
4. **iOS** — a real gap; likely needs a thin native wrapper or Shortcuts integration
5. **Paid AI tier** — free-tier training terms are not acceptable for other people's financial data. Budget for paid API before onboarding a single external user.

The wedge is not "better expense tracker." It's *"the tracker that fills itself for people who pay by UPI"* — a specific, underserved, very large group that every Western budgeting app handles badly.
