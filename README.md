# Paisa

Upload UPI screenshots, get a real ledger. The image never leaves the device.

Spec: [`BUILD_GUIDE.md`](BUILD_GUIDE.md) · Decisions and reasoning: [`HANDOFF.md`](HANDOFF.md) · Accounts and config: [`SETUP.md`](SETUP.md)

## Run it

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase URL + anon key
npm run dev
```

Then run `db/schema.sql` in the Supabase SQL editor once. `SETUP.md` covers
magic-link auth, the email template, and deployment.

## Commands

| | |
|---|---|
| `npm run dev` | local dev server |
| `npm run ocr` | OCR every image in `screenshots/` → `screenshots/ocr-output.txt` |
| `npm test` | parser checks — run this after touching `src/lib/parse.js` |
| `npm run icons` | regenerate the PWA icons |
| `npm run build` | production build |

## Where things live

```
src/lib/ocr.js          image → text, on device, image discarded
src/lib/parse.js        text → {amount, payee, date, ref}   ← tune against real OCR
src/lib/seeds.js        known Indian brands, no AI needed
src/lib/categorise.js   the cascade: personal → map → seeds → AI
src/lib/db.js           Supabase reads/writes, dedup by txn_ref
src/screens/            Today, Ledger, Insights, Review, Teach, Import
api/categorise.js       serverless; sends merchant strings to Gemini, nothing else
```

## The three rules that keep it correct

1. **`type` decides what counts.** Every spending number filters `type = 'expense'`.
   A credit-card bill paid over UPI is a `transfer`, not an expense.
2. **Strip commas before `Number()`.** `1,00,000` parses as 1 otherwise. That's the
   100× bug, and there's a test for it.
3. **Nothing but a merchant name goes to the AI.** No amount, no date, no image,
   no UPI ID. Person-to-person payments never leave the phone at all.

## Status

Parsers ship with placeholder patterns and passing tests against synthetic
screenshots. They get rewritten against real OCR output — drop screenshots in
`screenshots/`, run `npm run ocr`, tune `src/lib/parse.js`, run `npm test`.
