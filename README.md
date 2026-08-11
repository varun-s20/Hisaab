# Hisaab

**UPI screenshots in, a real ledger out. The image never leaves the phone.**

A single-user expense tracker for people who pay for everything over UPI in
India. You take a screenshot of a payment the way you already do, share it into
the app, and it becomes a categorised row. No bank login, no account
aggregator, no SMS scraping, no image upload.

Spec: [`BUILD_GUIDE.md`](BUILD_GUIDE.md) · Decisions and reasoning:
[`HANDOFF.md`](HANDOFF.md) · Accounts, keys, deployment: [`SETUP.md`](SETUP.md)

---

## Why this exists

Every Indian expense app wants read access to your bank, and gives you a
dashboard in return. The actual daily question is smaller than a dashboard:
*am I okay this month, and where did it go?*

Screenshots are the one artifact that already exists for every UPI payment,
on every app, with no permissions to grant. The bet is that reading them
on-device gets you ~70% of a true ledger for zero access, and a monthly CSV
import closes the rest.

## How it works

```
screenshot  ─►  OCR on device  ─►  parse  ─►  categorise  ─►  Supabase row
 (or share       (Tesseract       (amount,    (cascade,        (yours, RLS'd)
  sheet)          WASM, local)     payee,      see below)
                                   date, ref)
        ▲                                                          │
        └──────────── image discarded, never uploaded ─────────────┘
```

Anything the parser half-reads is still stored — it lands in **Needs a look**
with the raw OCR text attached, rather than vanishing with a count to show for
it. Re-uploading yesterday's screenshots is a silent no-op: the UPI reference
is a unique index.

## The privacy claim, and what enforces it

The claim is narrow and mechanical: **the image never leaves the device, and
the only thing any model ever sees is a merchant name.**

| Enforced by | Where |
|---|---|
| CSP `connect-src` — Supabase, Google Fonts and same-origin only | `index.html` |
| Tesseract worker, WASM core and language data self-hosted, not from a CDN | `src/lib/ocr.js`, `public/tesseract/` |
| Only merchant strings are posted — no amount, no date, no UPI ID, no image | `api/categorise.js` |
| Person-to-person payments never reach the AI at all | `src/lib/categorise.js` |
| Ask sends the question, your category and method names, and today's date — never a transaction | `api/ask.js`, `src/screens/Ask.jsx` |
| Both functions 401 without a signed-in caller — they spend your Gemini quota | `api/_auth.js` |
| Row-level security on every table; no storage bucket exists | `db/schema.sql` |

Supabase's `anon` key is public by design. RLS is what protects the data.

## Categorisation cascade

Stop at the first hit. Each tier is cheaper and more trustworthy than the one
below it:

1. **Merchant map** — a correction you made outranks everything.
2. **The app's own tag** — Paytm already labels rows *Food*, *Money Transfer*.
3. **Seed rules** — hardcoded Indian brands, local, no call.
4. **Personal check** — a bare name or UPI handle is a transfer, not spending.
5. **Gemini** — one batched call, merchant strings only.

Seeds rank *above* the personal check on purpose: plenty of brands read as
people ("Swiggy Diners", "Kunafa Mahal"), and ranked the other way a ₹1,978
dinner is silently typed as a transfer and disappears from every total. Half of
Indian merchants genuinely *are* people — the chaiwala, the sabziwala, the man
who fixes your bike — so this ordering is the whole ballgame.

Every AI answer is written back to the merchant map, so the same merchant costs
one call, ever. **Merchants** shows what the app has learned and lets you undo
any of it.

## Screens

| | |
|---|---|
| **Today** | One sentence about the week, one number for today, one place to drop a screenshot |
| **Ledger** | Every row, by day / week / month / custom range |
| **Insights** | Findings in sentences first, then the charts. Detects subscriptions you forgot you had |
| **Budgets** | The only number the ledger cannot derive — pace against limit, per category |
| **Ask** | "What did I spend on food last month?" A filter comes back and runs on-device |
| **Review** | Anything the parser wasn't sure about |
| **Teach** | Unknown merchants, one tap each |
| **Merchants** | What the app has learned, editable |
| **Import** | Monthly CSV/statement reconciliation — what makes the ledger true rather than indicative |

**Ask** is the one place a second model call earns its cost. The model returns
a *filter spec*, not an answer — every field is snapped to a value the app
already knows before it can touch anything, and nothing is interpolated into a
query string. With no key, no quota or no signal it falls back to a local
pattern guess.

## Data model

Three tables, all RLS'd to `auth.uid()`:

- `transactions` — one row per payment. `amount` is nullable on purpose;
  `txn_ref` is the dedup key; `raw_text` keeps the OCR output for parser
  debugging.
- `merchant_map` — the learned asset, and the most valuable table here.
- `budgets` — per-category monthly limits.

## Stack

React 19 + Vite · Supabase (Postgres, RLS, emailed-code auth) · Tesseract.js
(on-device OCR) · Gemini via two Vercel functions · vite-plugin-pwa ·
recharts. No CSS framework, no state library, no ORM.

Installable PWA with an Android share target — screenshot → Share → Hisaab,
without opening the app first. Works offline after first launch.

## Run it

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase URL + anon key
npm run dev
```

Run `db/schema.sql` in the Supabase SQL editor once.
[`SETUP.md`](SETUP.md) covers the emailed-code auth, the two branded email
templates in `supabase/email/`, the Gemini key, and deploying to Vercel +
installing on the phone.

`npm run dev` also serves `api/categorise.js` and `api/ask.js`, so the AI tier
is testable locally. Leave `GEMINI_API_KEY` out entirely and everything still
works — you just categorise unknown merchants by hand.

## Commands

| | |
|---|---|
| `npm run dev` | local dev server, including the API routes |
| `npm run ocr` | OCR every image in `screenshots/` → `screenshots/ocr-output.txt` |
| `npm test` | 36 parser/query/recurring checks — run after touching `src/lib/parse.js` |
| `npm run icons` | regenerate the PWA icons |
| `npm run build` | production build |

## Where things live

```
src/lib/ocr.js          image → text, on device, image discarded
src/lib/parse.js        text → {amount, payee, date, ref}   ← tune against real OCR
src/lib/statement.js    CSV/statement text → the same row shape
src/lib/seeds.js        known Indian brands, no AI needed
src/lib/categorise.js   the cascade: map → app tag → seeds → personal → AI
src/lib/recurring.js    subscriptions, found by arithmetic on rows already loaded
src/lib/query.js        a question becomes a filter, run on device; snaps model output
src/lib/db.js           Supabase reads/writes, dedup by txn_ref
src/screens/            Today, Ledger, Insights, Budgets, Ask, Review, Teach, Import, Merchants
api/categorise.js       serverless; sends merchant strings to Gemini, nothing else
api/ask.js              serverless; sends the question, never a transaction
api/_auth.js            both endpoints require a signed-in caller
public/tesseract/       self-hosted OCR worker, WASM core and language data (19MB)
db/schema.sql           three tables, RLS on all of them
```

## The three rules that keep it correct

1. **`type` decides what counts.** Every spending number filters
   `type = 'expense'`. A credit-card bill paid over UPI is a `transfer`.
2. **Strip commas before `Number()`.** `1,00,000` parses as 1 otherwise.
   That's the 100× bug, and there's a test for it.
3. **Nothing but a merchant name goes to the AI.** No amount, no date, no
   image, no UPI ID.

## Status

Working end to end. `npm test` — 36 checks passing.

`src/lib/parse.js` is the file that keeps moving: its structure is right, but
the specific patterns are only as good as the screenshots they've seen. Drop
new ones in `screenshots/`, run `npm run ocr`, tune, run `npm test`. That
folder is gitignored — screenshots never leave the machine.
