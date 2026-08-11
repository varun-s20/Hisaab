-- Hisaab — wipe every row, keep the schema.
--
-- Run this in the Supabase SQL editor when you want a fresh ledger. It empties
-- the three tables and leaves the tables, indexes, constraints and RLS policies
-- exactly as schema.sql created them, so nothing needs re-running afterwards.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS IS NOT REVERSIBLE. There is no undo, no trash, no soft delete. Supabase's
-- SQL editor runs as the service role, which bypasses row level security — so
-- these statements delete rows belonging to EVERY user, not just yours.
--
-- Before you run it:
--   1. Open the app → Ledger → set the range wide → "Export N rows as CSV".
--      That file is the only copy of your history once this runs.
--   2. Supabase → Database → Backups, if you are on a plan that has them.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1 — look before you delete. Run this on its own first.
select
  (select count(*) from transactions) as transactions,
  (select count(*) from merchant_map) as merchants_learned,
  (select count(*) from budgets)      as budgets;

-- Step 2 — the wipe. Select these three lines and run them together.
-- Order does not matter: there are no foreign keys between the three.
delete from transactions;
delete from merchant_map;
delete from budgets;

-- Step 3 — confirm. Every count should be 0.
select
  (select count(*) from transactions) as transactions,
  (select count(*) from merchant_map) as merchants_learned,
  (select count(*) from budgets)      as budgets;


-- ── If you ever want to wipe only your own rows ──────────────────────────────
-- On a shared project, scope by user. Get the id from Authentication → Users.
--
--   delete from transactions where user_id = '00000000-0000-0000-0000-000000000000';
--   delete from merchant_map  where user_id = '00000000-0000-0000-0000-000000000000';
--   delete from budgets       where user_id = '00000000-0000-0000-0000-000000000000';


-- ── What this does NOT clear ─────────────────────────────────────────────────
-- Two things live in the browser, not the database, and survive this file:
--
--   hisaab.categories   the categories you invented, in localStorage
--   theme               light / dark
--
-- The rename from Paisa to Hisaab already orphaned the old `paisa.categories`
-- key, so a renamed build starts with the fourteen built-ins regardless. To
-- clear the rest: Chrome → site settings for your domain → Delete data. That
-- also drops the service worker and its caches, which forces a clean reinstall
-- of the PWA — worth doing once, right after the first deploy under the new
-- name, so no stale Paisa service worker is left claiming the origin.
