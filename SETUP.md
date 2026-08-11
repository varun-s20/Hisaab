# Paisa — setup

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

## 3. Magic-link auth

### 3a. Turn on the email provider

**Authentication → Sign In / Providers → Email**

- `Enable Email provider` — **on**
- `Confirm email` — **on** (this is what makes the magic link a login link)
- `Allow new users to sign up` — **on** while you sign up, then turn it **off**.
  With it off, only your email can ever get a link. This is the whole access
  control for a single-user app.

### 3b. Tell Supabase which URLs are allowed

**Authentication → URL Configuration**

| Field | Value |
|---|---|
| Site URL | `https://paisa.yourdomain.com` (your production URL) |
| Redirect URLs | `http://localhost:5173/**` <br> `https://paisa.yourdomain.com/**` <br> `https://*-yourname.vercel.app/**` |

Without the localhost entry, links from local dev bounce to production and the
login fails silently. The `/**` wildcard matters — an exact URL without it
rejects any link carrying query params, which every magic link does.

### 3c. The email itself

**Authentication → Emails → Templates → Magic Link**

Subject:

```
Your Paisa sign-in link
```

Message body (switch the editor to **Source / HTML** and replace everything):

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0E1012;padding:40px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <tr>
    <td align="center">
      <table width="100%" style="max-width:420px;background:#181B1E;border-radius:14px;padding:32px">
        <tr>
          <td>
            <p style="margin:0 0 4px;color:#E8A33D;font-size:13px;letter-spacing:.12em;text-transform:uppercase">Paisa</p>
            <h1 style="margin:0 0 16px;color:#E8E6E1;font-size:22px;font-weight:600">Sign in</h1>
            <p style="margin:0 0 28px;color:#8A8F94;font-size:15px;line-height:1.5">
              Tap the button to open your ledger. The link works once and expires in an hour.
            </p>
            <a href="{{ .ConfirmationURL }}"
               style="display:inline-block;background:#E8A33D;color:#0E1012;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:10px">
              Open Paisa
            </a>
            <p style="margin:28px 0 0;color:#8A8F94;font-size:13px;line-height:1.5">
              Or paste this code into the app: <strong style="color:#E8E6E1;font-size:17px;letter-spacing:.15em">{{ .Token }}</strong>
            </p>
            <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #262A2E;color:#8A8F94;font-size:12px;line-height:1.5">
              Didn't ask for this? Ignore it — nothing happens until the link is opened.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

**Save.** The template variables Supabase substitutes:

| Variable | What it is |
|---|---|
| `{{ .ConfirmationURL }}` | the full one-tap link (required — without it the email is useless) |
| `{{ .Token }}` | the 6-digit code, for when tapping the link opens the wrong browser |
| `{{ .SiteURL }}` / `{{ .Email }}` / `{{ .RedirectTo }}` | available, not used above |

The 6-digit code is not decoration. On Android, tapping a link inside Gmail can
open a different browser than the installed PWA, which loses the session. The
app has a code box for exactly that case.

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
gh repo create paisa --private --source=. --push
```

Then Vercel → Add New → Project → import the repo. Framework preset: **Vite**.
Build command `npm run build`, output `dist`. Add the env vars from §4 before
the first deploy.

**Domain:** Vercel → Settings → Domains → add `paisa.yourdomain.com`, then set the
CNAME at your registrar as instructed. Come back and update Supabase's Site URL
(§3b) to match.

**Install on the phone:** open the URL in Chrome on Android → ⋮ → *Add to Home screen*.

### Verify after install

- Airplane mode → app still opens
- First OCR after a fresh install doesn't stall on a 10MB download
- Uploading the same screenshot twice creates one row, not two
- Supabase → Storage has **no bucket at all** (images are never uploaded)
