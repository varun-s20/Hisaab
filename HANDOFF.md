# Handoff — AI workflows, agents, and the Paisa expense tracker

Conversation knowledge base. Dated 11 August 2026.
Paste this at the start of a new chat to restore full context.

---

## How to use this document

If you're an AI assistant reading this: this is the compressed history of a long design conversation. It contains **decisions and the reasoning behind them.** Reasoning matters more than the conclusions — if the user's constraints change, you need to know *why* something was chosen to know whether it still holds.

Companion document: `BUILD_GUIDE.md` — the actual implementation spec.

**Ask questions rather than assume.** Several things below are marked open.

---

## 1. Who this is for

- Based in Lucknow, India. Pays for most things via UPI (GPay/Paytm/PhonePe).
- **Limited hands-on coding experience.** Has built basic automation flows with AI assistance. Learns by building.
- Explicit dual goal: **learn these platforms by building real things they personally use, then refine the good ones into products they could sell.**
- Owns two domains. Has Claude Max and Gemini Pro consumer subscriptions.
- Communication preference: direct, opinionated recommendations over menus of options. Pushes back well when something feels like unnecessary complexity — and has been right each time.

---

## 2. Broader context — how this conversation started

Began as a general discussion of AI agents and workflow automation (n8n, Obsidian, Notion, meeting notetakers), then narrowed to one concrete build.

### The forward-deployed-engineer framework we established

Applies to any workflow automation problem:

1. **Name the decision, not the task.** "I want meeting notes" is an artifact. "I want to never walk into Monday not knowing what I committed to" is the decision. Optimise for the decision.
2. **Do it manually five times and time it.** The real spec only appears in the doing.
3. **Separate the spine from the leaves.** The spine is the part whose failure makes everything else worthless. Spend 80% of effort there.
4. **Buy the spine, build the middle, own the context.** Never build commodity infrastructure. Differentiation is never in the commodity layer.
5. **Design the failure path before the happy path.** A workflow with no failure handling is 30% done, not 90%.
6. **Keep a human checkpoint until you've earned removing it.**

### Sellability test (four questions)

- Does it survive being handed over? (needs explaining = service, not product)
- Is the pain recurring and expensive? (people pay for bleeding, not tidy)
- Who already pays for a worse version? (incumbents prove budget exists)
- What's the wedge? (a specific person's specific workflow, never "better X")

### Key licensing finding — n8n

n8n's Sustainable Use License permits internal business use. Consulting on a client's own instance is fine. **Permanently hosting clients' workflows on an instance you operate requires a commercial licence** (Enterprise for hosting client data, Embed for building n8n into a product). Multi-tenancy is not native — real isolation means separate instances.

**Conclusion:** n8n is an excellent learning and prototyping substrate, and a poor product substrate. Prototype in n8n until logic stops changing, then port to code.

### Obsidian — what it's actually for

Obsidian is a text editor pointed at a folder of `.md` files. That's the whole model.

- **Why it matters for agent building:** a folder of markdown is the cheapest agent-friendly database that exists. No API, no auth, no rate limits. Claude can read it natively.
- **Frontmatter** (YAML properties) is the bridge — plain text an agent parses trivially, but Obsidian treats the keys as structured fields.
- **Bases** is now a core plugin providing database-like views (tables, cards, lists) over those properties. It supersedes Dataview for most uses.
- **Split of responsibilities:** Notion (or Postgres) for structured records a workflow writes to; Obsidian for thinking, long-form notes, raw transcripts — anything an AI needs to read a lot of, cheaply.
- **Bad at:** multiplayer, being a product backend, relational data.
- **Main failure mode:** spending a month building an elaborate PKM system and never writing anything. Start almost bare.

### Personal automation idea backlog

Discussed at length; not built. Highest-value ones flagged.

- **Universal capture bot** — text anything, it routes to task/note/expense. *Recommended as the front door to everything else.*
- **Personal CRM** — everyone you meet gets a note; nudge when contact decays. *Quietly very high value.*
- **Weekly reflection generator** — reads calendar, completed tasks, journal; drafts a review. *Behaviour-changing.*
- **Ask-my-vault (RAG over Obsidian)** — *most transferable skill on the list.*
- Others: email digest, follow-up detector, read-later processor, YouTube→notes, subscription auditor, receipt extractor, document expiry alerts, travel itinerary assembler, standup generator, prep briefs, meal plan→grocery list.

Two rules agreed: **build only what annoyed you this week**, and **let a broken flow stay broken for a few days** — if you don't miss it, delete it.

### The meeting notetaker (parked, not abandoned)

Original build idea: a Fireflies competitor that joins Meet/Zoom/Teams, transcribes, extracts commitments, routes to Notion/Calendar, and tracks follow-through.

Architecture agreed: capture (**buy** — Recall.ai, Skribby ~$0.35/hr, MeetingBaaS, or self-hosted Vexa) → transcribe (bundled) → **understand (build)** → **context layer (build — the moat)** → route → **follow-through loop (build — nobody does this well)**.

Key insight: the differentiation is not transcription. It's that the system knows your projects and people, and checks whether commitments were actually kept.

Constraints noted: Zoom requires App Marketplace approval; consent law varies (India needs one-party, EU and several US states need all-party).

**Status: parked.** Revisit after Paisa ships.

---

## 3. The current project — Paisa

**What:** an Android-first PWA. Upload UPI payment screenshots, get a real expense ledger. No manual data entry.

**Why this one:** the user wanted a real tool they'd use daily, that teaches the full stack (frontend, auth, database, vision/AI, deployment), and that has a plausible commercial path.

### Requirements, in the user's words

- Every rupee tracked — real totals, not indicative
- Handle income and transfers, not just spend
- Beautiful visualisation, "professional money app kinda thing but with ease"
- **One app.** No Telegram, no second surface, no separate tool
- **Agent-like, not data entry.** "All I'm doing is uploading a ss and not pushing manual buttons or commands everytime"
- Manual entry acceptable only for genuine cash payments
- Reminder to upload, since it's an end-of-day batch habit
- **Free to run**
- **No data given away**

---

## 4. Decision log — what was chosen and why

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Storage | Supabase (Postgres) | Google Sheets, Notion, Obsidian | Sheets was recommended when the plan was no-app; once building an app it becomes a liability (quotas, latency, no querying). Notion charts can't reach "professional money app" quality and its API rate-limits bulk imports. |
| Capture | In-app multi-select upload | Telegram bot, share-target only | Telegram was a genuinely separate product — correctly rejected by the user. Share-target is Android-only and worse for batch. |
| OCR | Tesseract.js, on-device | Cloud vision API | Free, and the image never leaves the phone. **The user initially thought this was "another layer like Telegram" — it isn't; it's an npm library inside the app.** Worth restating if confusion recurs. |
| AI | Gemini API free tier, merchant strings only | Claude API, Claude Max, Gemini Pro sub | Consumer subscriptions do not grant API access — this was checked and confirmed. Gemini's developer free tier is separate and genuinely free. |
| Extraction | Deterministic cascade, LLM last | LLM-first on every image | Payment screenshots are fixed templates. Using vision AI on them is like hiring a translator for a form you designed. Cuts cost to ~zero and is better engineering. |
| Hosting | Vercel/Cloudflare + own subdomain | — | Free tier covers custom domains and the serverless function needed to hide the API key. |
| Reminder | Phone alarm for v1 | Web Push | Push is 2-3 hours of fiddly work; an alarm is 15 seconds. Add push in Phase 3 once it can carry a count. |
| Images | Discarded after OCR | Stored in Supabase Storage | Eliminates almost all privacy liability for near-zero benefit — the payment app itself is the source of record. |

### The privacy design, stated plainly

The insight that resolved the whole concern: **don't send the image, send the merchant name.**

What Gemini receives: `"BHARATPE09283746"` → `"Food & Dining"`. No amount, date, balance, UPI ID, reference, or name. Batched end-of-day, ~20-30 requests a month against a daily limit in the hundreds.

Plus two local rules: **person-to-person payments never hit the API** (regex-detected), and **images are never stored.**

### The "agent not data entry" rule

The thing that makes an app feel like a chore isn't screen count — it's **being asked to confirm things it already knows.** A review queue where you tap "yes" twenty times is data entry with extra steps.

So: confidence-scored transactions. ≥0.7 saves silently, 0.4–0.7 saves flagged for weekly cleanup, <0.4 surfaces now. The user sees *"18 transactions logged, ₹4,320. 2 need a look"* — not twenty cards.

**Fewer questions, not fewer buttons.**

### The honest constraint the user accepted

Browsers require a user gesture to open a file picker. So "Route A" is **one tap**, not zero. True zero-touch needs the Phase 3 Drive-watcher — which trades away the never-leaves-the-device guarantee. User chose Route A knowingly.

---

## 5. Facts worth not re-deriving

- **Claude Max / Gemini Pro subscriptions do not include API access.** Separate billing. Routing an app through Claude Code as a headless backend is outside intended use and operationally fragile.
- **Gemini free tier:** key from AI Studio, no credit card. Limits are per Google Cloud *project*, not per key, and have been cut before (December 2025). Published numbers vary wildly across sources — **check the live rate-limit view in AI Studio, not blog posts.** Free-tier inputs may be used for model training; paid tier and Vertex AI do not.
- **Supabase free tier pauses after ~7 days of inactivity.** Resumes on access, slowly.
- **Tesseract first run downloads ~10MB** of language data. Must be cached in the service worker or the first use feels broken.
- **Indian number grouping** (`1,00,000`) breaks naive parsing. Strip commas before `Number()`.
- **iOS has no Web Share Target API.** Android-only feature.
- **`showDirectoryPicker()` is desktop-only** — a PWA cannot watch the gallery folder on Android. This is why zero-touch requires a server-side Drive watcher.
- **Screenshots alone capture ~70% of transactions.** Monthly statement reconciliation is what makes the ledger true.
- **Transfers must be typed separately** or totals become fiction — a credit card bill paid via GPay is not an expense.

---

## 6. Where things stand

**Nothing built yet.** The conversation ended at the point of handing over specs.

**Immediate next action:** the OCR spike (`BUILD_GUIDE.md` §6.1). A single HTML file, opened on the actual phone, fed real GPay/PhonePe/Paytm screenshots, dumping raw text.

That output is the specification for every parser in the app. **Do not write regexes against imagined layouts.** This is the one genuinely uncertain assumption in the whole project, and it's an evening's work to resolve.

Then: Phase 1 (screenshot → correct database row, no categories, no charts) → Phase 2 (merchant map, AI fallback, confidence rules) → Phase 3 (dashboard, statement import, zero-touch ingest).

---

## 7. Open questions

1. **Auth** — hardcoded single user, or Supabase magic-link?
2. **iPhone** — needed, and when?
3. **Credit cards** — statement import only, or something else?
4. **Multiple bank accounts / UPI apps** — separate them?
5. **Cash** — what share of spending? Determines quick-entry priority.
6. **Historical backfill** — start today, or import 6 months?
7. **Drive watcher** — is server-side image processing an acceptable trade for zero-touch?
8. **Meeting notetaker** — still wanted after this ships?

---

## 8. Restarting a conversation

Paste this document plus `BUILD_GUIDE.md` and say something like:

> Here's the context from a previous conversation. I'm at [stage]. [What happened / what broke]. Help me with [next thing].

Useful restart points:

- *"Here's my real OCR output for GPay/PhonePe/Paytm — write the parsers."*
- *"Phase 1 works. Build the categorisation cascade and merchant map."*
- *"Design and build the dashboard."*
- *"Let's go back to the meeting notetaker."*
- *"I want to turn this into something I can sell — what changes?"*
