-- Repeats: bills that come round, and the things you log every day.
--
-- Run this once in the Supabase SQL editor on a database that already exists.
-- `create table if not exists` in db/schema.sql will not add a table to a
-- database that was created before it was written, which is why this file is
-- separate. A brand new project gets it from db/schema.sql (or, on your own
-- project, db/byo-setup.sql) and never needs this.
--
-- Safe to re-run.

-- ── One table, because they are one thing ──────────────────────────────────
--
-- A saved payment, optionally with a schedule attached.
--
--   rule is null   a tile. It sits on Today and you tap it to log the payment.
--                  Chai ₹20. Nothing happens on its own.
--   rule is set    a bill. Rent on the 5th, the SIP on the 1st, the maid on the
--                  last day. It tells you it is due; it never posts by itself.
--
-- These were very nearly two tables, and they should not be: the columns that
-- describe the payment are identical, both are edited on the same screen, both
-- have to survive a backend switch, and the only difference between them is
-- whether a person wants to be reminded. A second table would have duplicated
-- fifteen columns and every backend method that touches them.
create table if not exists templates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) default auth.uid(),

  -- What it is called on the tile and in the list. Short on purpose: it has to
  -- fit a button four across on a 320px phone.
  label          text not null check (length(label) between 1 and 40),

  -- The payment this writes. Same columns as `transactions`, same meanings.
  -- Amount is nullable: a grocery run repeats at a different price every time,
  -- and a tile that fills in everything except the number is still most of the
  -- typing saved.
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

  -- The schedule, or null. jsonb rather than eight columns because the shape is
  -- the app's and only the app reads it:
  --
  --   { "every": 1, "unit": "month", "monthDay": 5 }
  --   { "every": 1, "unit": "month", "lastDay": true }
  --   { "every": 2, "unit": "week", "weekday": 0 }
  --   { "every": 3, "unit": "day" }
  --   …any of those plus { "until": "2027-03-31" }
  --
  -- Postgres cannot check it and is not asked to. src/lib/schedule.js validates
  -- every rule on the way OUT of the database as well as in — see ruleProblem —
  -- because jsonb will happily store `{"every": 0}` and a naive date walk over
  -- that never terminates.
  rule           jsonb,

  -- What the schedule is measured from, and how far it has got. Every
  -- occurrence is computed from starts_on, never from the previous one, so a
  -- bill on the 31st goes 31 Jan → 28 Feb → 31 Mar instead of ratcheting down
  -- to the 28th and staying there.
  starts_on      date,
  last_posted_on date,

  -- On the Today screen as a tile. A suggestion the app worked out from your
  -- history is not a row until you pin it — nothing here is written by
  -- guessing.
  pinned         boolean not null default false,

  -- "Not a bill", and "stop offering me this". A hidden row is a tombstone: it
  -- names a payee that must not come back as a suggestion. It has no rule and
  -- shows nowhere except the list of things you have dismissed.
  hidden         boolean not null default false,

  source         text not null default 'user' check (source in ('user','detected')),
  created_at     timestamptz default now()
);

create index if not exists templates_user_idx on templates (user_id);

-- ── Row level security ─────────────────────────────────────────────────────
-- Same rule as every other table here: you see your rows and nobody else's.
-- A template holds a payee, an amount and an account name, which is the same
-- class of data as a transaction and gets the same protection.
alter table templates enable row level security;

drop policy if exists "own templates" on templates;
create policy "own templates" on templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Check ──────────────────────────────────────────────────────────────────
-- One row, rowsecurity = true.
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public' and tablename = 'templates';
