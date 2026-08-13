-- Hisaab, on your own Supabase project.
--
-- Paste this whole file into your project's SQL editor and press Run. Once.
-- Safe to run again if you are not sure whether it worked.
--
-- This is everything: db/schema.sql plus every migration, already applied. You
-- never need to run those files — they exist to bring an OLD database forward,
-- and yours is new.
--
-- What is deliberately NOT here: the access_requests table. That is Hisaab's
-- own invite queue and it lives on Hisaab's project, not yours. You sign in to
-- Hisaab exactly as you did before; this database only holds your money.

-- ── Transactions: one row per payment ──────────────────────────────────────
create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),

  txn_ref       text,                    -- UPI reference; dedup key
  txn_date      date not null,
  txn_time      time,

  -- Nullable on purpose: a screenshot whose amount the OCR mangled still has to
  -- be stored, or it vanishes with nothing but a count to show for it. It lands
  -- in "Needs a look" with the raw text attached. Always positive when present.
  amount        numeric(12,2),
  direction     text not null check (direction in ('debit','credit')),
  -- 'investment' is money put away, not spent: it counts in neither spending
  -- nor income and has its own view on Insights.
  type          text not null default 'expense'
                check (type in ('expense','income','investment','transfer','refund','lent','repaid')),

  payee_raw     text not null,           -- exactly as OCR'd
  payee_clean   text,                    -- after merchant map
  category      text,
  subcategory   text,

  method        text,                    -- gpay | phonepe | paytm | card | cash | netbanking
  account       text,                    -- which bank/card/envelope the money LEFT
  -- Where it landed, on a transfer between two of your own accounts. Null on
  -- everything else, because an expense has no destination you own.
  to_account    text,

  source        text not null default 'screenshot'
                check (source in ('screenshot','statement','manual')),
  confidence    numeric(3,2) default 1.0,
  needs_review  boolean default false,
  note          text,

  raw_text      text,                    -- OCR output, for debugging parsers
  created_at    timestamptz default now()
);

-- Dedup: the same UPI ref can only exist once per user.
-- Re-uploading yesterday's screenshots is a silent no-op.
create unique index if not exists txn_ref_unique
  on transactions (user_id, txn_ref)
  where txn_ref is not null;

create index if not exists txn_date_idx on transactions (user_id, txn_date desc);

-- ── Merchant map: the learned asset. The most valuable table here. ─────────
create table if not exists merchant_map (
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

-- ── Categories you made yourself ──────────────────────────────────────────
-- Only the ones you invent. The fourteen built-in ones are in the app, not
-- here. Colour and icon live with the name so a reinstall or a second device
-- gets your category back looking like your category.
create table if not exists categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) default auth.uid(),
  name       text not null check (length(name) between 1 and 28),
  color      text not null default '#E7E7E1',
  icon       text not null default 'other',
  created_at timestamptz default now(),
  unique (user_id, name)
);

-- ── Budgets: the one number the ledger can't derive ───────────────────────
-- One monthly cap per category. The reserved category '*' is the cap for the
-- whole month across every category.
--
-- `scope` says what the `category` column is naming. Envelope budgeting caps
-- the pocket, not the kind of spending. The unique key carries the scope, or an
-- account and a category of the same name would collide — and "Transfers" is
-- plausibly both.
create table if not exists budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),
  scope         text not null default 'category' check (scope in ('category','account')),
  category      text not null,
  amount        numeric(12,2) not null check (amount > 0),
  created_at    timestamptz default now(),
  unique (user_id, scope, category)
);

-- ── Repeats: bills that come round, and what you log every day ────────────
--
-- A saved payment, optionally with a schedule attached.
--
--   rule is null   a tile on Today. Tap it to log the payment. Chai ₹20.
--   rule is set    a bill. It tells you it is due; it never posts by itself.
--
-- The rule is jsonb — { "every": 1, "unit": "month", "monthDay": 5 } and
-- friends. The app validates it on the way out as well as in, because the
-- database cannot.
create table if not exists templates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) default auth.uid(),

  label          text not null check (length(label) between 1 and 40),

  payee          text not null check (length(payee) between 1 and 120),
  amount         numeric(12,2) check (amount is null or amount > 0),
  category       text,
  type           text not null default 'expense'
                 check (type in ('expense','income','investment','transfer','refund','lent','repaid')),
  direction      text not null default 'debit' check (direction in ('debit','credit')),
  method         text,
  account        text,
  to_account     text,
  note           text check (note is null or length(note) <= 140),

  rule           jsonb,
  starts_on      date,
  last_posted_on date,

  pinned         boolean not null default false,
  hidden         boolean not null default false,
  source         text not null default 'user' check (source in ('user','detected')),
  created_at     timestamptz default now()
);

create index if not exists templates_user_idx on templates (user_id);

-- ── Row level security ─────────────────────────────────────────────────────
--
-- This is not optional and it is not ceremony. The key Hisaab holds for this
-- project is the anon public key, which is designed to be readable by anyone
-- who has it — what stops a stranger reading your ledger is these policies and
-- nothing else. With RLS off, your project URL plus that key is your entire
-- financial history.
alter table transactions enable row level security;
alter table merchant_map enable row level security;
alter table budgets      enable row level security;
alter table categories   enable row level security;
alter table templates    enable row level security;

drop policy if exists "own rows" on transactions;
create policy "own rows" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own categories" on categories;
create policy "own categories" on categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own map" on merchant_map;
create policy "own map" on merchant_map
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own budgets" on budgets;
create policy "own budgets" on budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own templates" on templates;
create policy "own templates" on templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Check ──────────────────────────────────────────────────────────────────
-- Five rows, all with rowsecurity = true. Anything else and Hisaab will refuse
-- to connect, which is the correct behaviour rather than an error to work
-- around.
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('transactions', 'merchant_map', 'budgets', 'categories', 'templates');
