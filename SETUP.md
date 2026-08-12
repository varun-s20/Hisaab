# Hisaab — setup

Everything you need to click through once. ~15 minutes.

---

## 1. Local env

```bash
cp .env.local.example .env.local
```

Fill both values from **Supabase dashboard → Project Settings → API**:

| Field in dashboard | Goes into |
|---|---|
| Project URL | `VITE_SUPABASE_URL` |
| `anon` `public` key | `VITE_SUPABASE_ANON_KEY` |

The `anon` key is safe in the browser — RLS is what protects the data, not the key.
The `service_role` key is not safe anywhere near this app. Never copy that one.

---

## 2. Database

Supabase dashboard → **SQL Editor** → New query → paste all of `db/schema.sql` → **Run**.

**On an existing database, also run `db/migrate-investment.sql`.** `create table
if not exists` will not widen a CHECK constraint on a table that is already
there, so without it saving a row as an *investment* fails with
`violates check constraint "transactions_type_check"`. It touches no data.

**On a database created before the approval queue existed, re-run the whole of
`db/schema.sql`.** Every statement in it is `if not exists` or a
`drop policy` / `create policy` pair, so re-running is a no-op on everything
that is already there and adds `access_requests`. Without that table, a new
address gets the invite-only message and you never see that they asked.

**Then run `db/migrate-accounts.sql`.** `create table if not exists` will not
add a column to a table that already exists, and will not widen a unique
constraint — so on an existing database this is what adds:

- `transactions.to_account`, the half of a transfer that says where the money
  *landed*. Without it an envelope balance is unanswerable, and a budgeting-app
  import leaves rows filed under an account literally called
  `SBI Bank->Needs`. The migration splits any it finds.
- `budgets.scope`, so a monthly cap can name an account rather than a category,
  and the unique index that has to gain the column with it.

It ends with a `select` that should return **zero rows**. Anything it returns
still has both halves of a transfer in one cell.

**Then run `db/migrate-access-status.sql`.** This is what turns
`access_requests` from a list into a queue: `status`, `decided_at` and
`notified_at`, and it drops the public INSERT policy the browser used to write
through. Run it on a fresh database too — `db/schema.sql` still creates the
table the old way. Safe to run twice.

Verify: **Table Editor** should now show `transactions`, `merchant_map`,
`budgets` and `access_requests`, all with a green "RLS enabled" badge.
`access_requests` should have **no policies at all** — that is correct now, and
means nothing holding the anon key can read or write it.

---

## 3. Email-code auth

No password, no link — a six-digit code, typed into the app that is already
open. There used to be a link here; on Android, tapping one inside Gmail opens
whichever browser Gmail feels like rather than the installed PWA, so the session
landed in a window nobody was looking at.

### 3a. Turn on the email provider

**Authentication → Sign In / Providers → Email**

- `Enable Email provider` — **on**
- `Confirm email` — **on** (this is what makes the emailed code a login)
- `Allow new users to sign up` — **on** while you create your own account, then
  turn it **off** and leave it off. See 3a-2.

### 3a-2. Sign-up is by approval

Two locks, and either one is enough:

1. **`Allow new users to sign up` — off.** Server-side, applies to every client
   there will ever be, including one written by somebody else against the same
   anon key.
2. **`shouldCreateUser: false`** in `src/screens/SignIn.jsx`. Belt to that
   braces, and the thing that makes the app *say* something useful when the
   address is unknown instead of showing a raw API error.

Without either, anyone with an email address can create an account — and an
account is a token, and a token passes `api/_auth.js` and spends your
`GEMINI_API_KEY` on every call it likes.

**What someone new sees.** They type their address, get *"Hisaab is invite-only.
You're on the waiting list — you'll usually hear back within 24–72 hours"*, and
a row lands in `access_requests` — written by the Worker, not the browser.

**This screen does tell a stranger whether an address has an account** — a known
one goes to the code field, an unknown one gets the invite-only line. That is
account enumeration, and it is the price of telling someone honestly that they
need to ask rather than leaving them staring at a code that will never arrive.
For an invite-only app it is a fair trade: knowing an address is registered gets
an attacker no closer to the mailbox, which is the only key. If you ever want it
closed, show the "check your email" line unconditionally and drop the request
flow — you cannot have both.

**How you approve: from your inbox.** You no longer open the dashboard for this.

1. They ask. `POST /api/access-request` writes the row and emails **you** at
   `ADMIN_EMAIL` — the address, when they asked, and two buttons.
2. Tap **Approve** or **Reject**. The link opens a page on your own domain that
   shows the address again with both buttons on it. **Opening the link decides
   nothing** — see below.
3. Press the button on that page. Approve creates the account and emails them a
   magic link (plus the code route underneath it, because on Android a link may
   open in the wrong browser). Reject emails a short decline.
4. Nothing to clean up. The row keeps its verdict, which is what stops the same
   address mailing you twice and what lets a rejected person ask again later.

Ignoring the mail is still a valid answer: the request stays `pending` forever
and the links expire after 7 days.

**Why opening the link is safe.** Mail clients, antivirus proxies and corporate
link scanners fetch URLs out of inboxes without anyone tapping them. If the link
itself approved, the first such fetch would approve whoever had just asked, and
nothing would look wrong. So the `GET` only renders; the decision is a form
`POST` from a button on that page. `scripts/test-access.mjs` asserts exactly
this — that a `GET` on the decide route mutates nothing at all.

**Why the link can't be forged.** It carries
`base64url(payload).base64url(HMAC-SHA256(payload, APPROVE_SECRET))`, with the
expiry inside the signed bytes. Edit the request id in it and the signature
stops matching. Once a decision is recorded the row is no longer `pending`, so a
forwarded mail cannot replay it. `scripts/test-token.mjs` covers the tampering,
expiry and wrong-secret cases.

**Rate limits**, because `/api/access-request` is unauthenticated by nature —
the caller has no account, that is the point:
- one admin email per address per 24 hours, however often they ask
- at most 20 admin emails an hour across every address, which is the cap that
  survives a script feeding it a fresh random address every second

Both are plain SQL against `access_requests`. Neither is visible to the person
asking: they get the same waiting-list line either way.

**To revoke:** Authentication → Users → delete the user. Their rows go with
them; every table is `references auth.users(id)`. Also set that row's `status`
back to `pending` (or delete it) if you want them able to ask again.

**Nothing in the browser can read or write this table.** `db/schema.sql` once
granted a public INSERT; `db/migrate-access-status.sql` drops it and replaces it
with nothing, so with RLS on and no policies the table is unreachable from the
anon key in either direction. The Worker writes it with the service role. That
is why there is still no admin screen in the app to build, secure, or forget
about — the admin screen is your inbox.

### 3b. Tell Supabase which URLs are allowed

**Authentication → URL Configuration**

| Field | Value |
|---|---|
| Site URL | `https://hisaab.yourdomain.com` (your production URL) |
| Redirect URLs | `http://localhost:5173/**` <br> `https://hisaab.yourdomain.com/**` <br> `https://*-yourname.vercel.app/**` |

Site URL is not optional even with no link to redirect through: the email
templates load the app icon from `{{ .SiteURL }}/icon-192.png`, so a wrong value
here is a broken logo in every sign-in email. Redirect URLs no longer carry a
login, but leave them correct — they are what any future OAuth or recovery flow
would use.

### 3c. The emails

Two templates, both in `supabase/email/` in this repo. Open each file, copy the
whole thing, and paste it into the matching template with the dashboard editor
switched to **Source / HTML**:

| File | **Authentication → Emails →** | Subject |
|---|---|---|
| `supabase/email/magic-link.html` | Magic Link | `Your Hisaab code is {{ .Token }}` |
| `supabase/email/confirm-signup.html` | Confirm signup | `Your Hisaab code is {{ .Token }}` |

Both are needed. Supabase picks Confirm signup the first time an address is ever
seen and Magic Link every time after, so leaving one on the stock template means
a first sign-in that looks nothing like the second — and, worse, still carries a
link.

**This is the switch that makes the auth code-based.** Supabase decides what to
send from what the template references, not from anything the app calls:

| Template contains | What arrives |
|---|---|
| `{{ .ConfirmationURL }}` | a one-tap link |
| `{{ .Token }}` | a six-digit code |
| both | both |

Neither file mentions `{{ .ConfirmationURL }}` anywhere, which is what makes the
mail code-only. Put it back and the link comes back with it — and `SignIn.jsx`
sends no `emailRedirectTo`, so that link would land on the Site URL regardless of
which device asked.

Other variables available: `{{ .SiteURL }}` and `{{ .Email }}`, both used above.

The templates carry a `prefers-color-scheme: dark` block built from the same
tokens as `src/styles.css`, so the email matches whichever way the phone is set.
The bright-green panel and the code block stay fixed in both — that pairing is
the brand, not a surface. Re-run `npm run icons` if the logo ever changes; the
email pulls the same `icon-192.png` the app and the installer do.

Gmail's app and Outlook.com ignore `prefers-color-scheme` entirely: they rewrite
the colours themselves and stamp `data-ogsc` / `data-ogsb` on whatever they
touched. The `[data-ogsc]` rules under the media query put the green panel and
its dark ink back — without them the heading is lightened onto a panel that
stays light green and reads as blank.

### 3c-2. The sender's profile picture

**No template change can set this, and neither can the app.** The avatar beside
the sender name in Gmail comes from one of exactly two places:

1. **BIMI.** A DNS record pointing at your logo, which mail providers fetch and
   display. It needs, in order:
   - `SPF` and `DKIM` passing, and `DMARC` at `p=quarantine` or `p=reject`
     (`p=none` is not enough — this is the part people miss)
   - the logo as **SVG Tiny PS**, square, on a solid background, hosted over
     HTTPS. Not the PNG in `brand/` — a different profile of SVG with no
     scripts, no external references, and a `<title>`
   - `default._bimi.yourdomain.com  TXT  "v=BIMI1; l=https://yourdomain.com/bimi/hisaab.svg; a=self"`
   - for **Gmail specifically**, a Verified Mark Certificate from Entrust or
     DigiCert (a paid, verified-trademark certificate) in the `a=` field.
     Without a VMC, Gmail will not show the mark. Yahoo and Fastmail will.

2. **A Google Workspace profile photo**, if the address you send from is a real
   Workspace mailbox and the recipient is on Gmail. Set the photo on that
   account and Gmail uses it. This is the cheap route and the one most small
   projects take — it needs the custom SMTP sender in §3d to be that mailbox.

Until one of those is in place, Gmail draws a coloured letter tile. That is not
something the HTML can override; anything claiming otherwise is describing the
tiny inline `icon-192.png` at the top of the message body, which the templates
already show.

### 3d. Email rate limit — read this before you get confused

Supabase's built-in email service is capped (roughly **2 emails per hour** on a
new project, and it is not meant for production). You will hit it while testing.

- Sessions persist in local storage and auto-refresh, so real daily use sends
  **zero** emails — you log in once per device.
- If you do get stuck testing: **Authentication → Rate Limits** shows the cap,
  and **Project Settings → Authentication → SMTP Settings** lets you point at
  Resend / Brevo (both have a free tier) to remove it. Not needed for one user.

---

## 4. Gemini key (Phase 2 categorisation)

Already have the key from aistudio.google.com. It goes **only** into Vercel:

**Vercel → Project → Settings → Environment Variables**

| Name | Value | Environments |
|---|---|---|
| `GEMINI_API_KEY` | your key | Production, Preview, Development |
| `VITE_SUPABASE_URL` | same as `.env.local` | all |
| `VITE_SUPABASE_ANON_KEY` | same as `.env.local` | all |

Check the live quota in AI Studio's rate-limit view, not blog posts — the
numbers have been cut before.

### Testing it locally

`npm run dev` serves `api/categorise.js` itself, so the AI tier can be exercised
without deploying. Add to `.env.local`:

```
GEMINI_API_KEY=AIza...
```

**Without a `VITE_` prefix.** Vite only inlines `VITE_*` variables into the
browser bundle; this one is read by the dev server in Node and never reaches a
client. Renaming it to `VITE_GEMINI_API_KEY` would publish your key to anyone
who opens DevTools.

Restart the dev server, then check it from the browser console on the app:

```js
await fetch('/api/categorise', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ merchants: ['BHARATPE09283746', 'MSWIPE*CAFE COFFEE'] }),
}).then(r => r.json())
```

Expect `{results: [{merchant, clean, category}, ...]}`. An empty `results` array
means the key is missing or the quota is spent — the app fails soft either way,
so unknown merchants just wait in *Teach me*.

Leave the key out entirely and everything still works; you simply categorise
those merchants by hand.

---

## 5. Deploy

```bash
git init && git add . && git commit -m "init"
gh repo create hisaab --private --source=. --push
```

### Cloudflare Workers

```bash
npm run build
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SUPABASE_URL         # same value as VITE_SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY    # same value as VITE_SUPABASE_ANON_KEY
npx wrangler deploy
```

**All three secrets are required.** `wrangler.jsonc` names `worker/index.js` as
the entry point and routes `/api/*` to it; without them `api/_auth.js` fails
closed and every AI call comes back 500.

This part is not optional decoration. A deploy with **no** `main` in
`wrangler.jsonc` serves static assets only: `POST /api/ask` falls through to the
SPA fallback, returns `index.html` with a 200, and the client reads that as a
failure and silently uses its offline parser for every question. The symptom is
Ask answering ₹0 to things it obviously should know, and unknown merchants
never being categorised at all. If you fork this, keep `main` and
`run_worker_first`.

### Or Vercel

Vercel → Add New → Project → import the repo. Framework preset: **Vite**.
Build command `npm run build`, output `dist`. Add the env vars from §4 before
the first deploy. `api/*.js` are already in Vercel's own function shape, so
nothing else is needed there.

**Domain:** Vercel → Settings → Domains → add `hisaab.yourdomain.com`, then set the
CNAME at your registrar as instructed. Come back and update Supabase's Site URL
(§3b) to match.

**Install on the phone:** open the URL in Chrome on Android → ⋮ → *Add to Home screen*.

### Verify after install

- Airplane mode → app still opens
- The first OCR downloads ~12MB from **your own domain** — check the Network tab
  shows `/tesseract/…` and nothing from `cdn.jsdelivr.net`. It is deliberately not
  precached: paying that cost at install, before you know the user will ever OCR
  anything, is worse. Every OCR after the first is offline.
- Uploading the same screenshot twice creates one row, not two
- Supabase → Storage has **no bucket at all** (images are never uploaded)
- `curl -X POST https://your-app/api/ask -d '{"question":"hi"}' -H 'content-type: application/json'`
  answers **401**. Both functions spend your Gemini key, so both require a signed-in caller.
