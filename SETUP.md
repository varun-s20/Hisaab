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

Verify: **Table Editor** should now show `transactions` and `merchant_map`, both with
a green "RLS enabled" badge.

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
- `Allow new users to sign up` — **on** while you sign up, then turn it **off**.
  With it off, only your email can ever get a code. This is the whole access
  control for a single-user app.

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

Then Vercel → Add New → Project → import the repo. Framework preset: **Vite**.
Build command `npm run build`, output `dist`. Add the env vars from §4 before
the first deploy.

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
