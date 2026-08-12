-- Approval by email, instead of by reading the dashboard.
--
-- `access_requests` used to be a bare list of addresses: written by the browser,
-- readable only in the Supabase dashboard, decided by hand. It now backs a real
-- queue — the Worker writes it with the service role, emails the admin two
-- signed links, and records what was decided.
--
-- Safe to run twice. Every statement is `if not exists` or a
-- `drop policy` / no-op pair.

alter table access_requests
  add column if not exists status text not null default 'pending';

-- Split from the add so re-running on a table that already has the column still
-- installs the constraint. `not valid` is deliberately not used: the table is
-- tiny and every existing row is 'pending' by the default above.
do $$
begin
  alter table access_requests
    add constraint access_requests_status_check
    check (status in ('pending', 'approved', 'rejected'));
exception
  when duplicate_object then null;
end $$;

-- When the decision was made. Null while pending.
alter table access_requests
  add column if not exists decided_at timestamptz;

-- When the admin was last emailed about this address. This is the rate limit:
-- one mail per address per 24 hours, so a bot hammering the ask endpoint with
-- the same address costs one email, not thousands.
alter table access_requests
  add column if not exists notified_at timestamptz;

-- The hourly cap counts rows by this column, and the per-address check reads it
-- on every ask. Both are hot enough on a table that only ever grows to justify
-- an index, and cheap enough on one this small not to think about it.
create index if not exists access_requests_notified_at_idx
  on access_requests (notified_at desc nulls last);

-- ── The browser no longer writes this table ──────────────────────────────
--
-- It used to hold a public INSERT policy, which meant anyone with the anon key
-- (it is in the bundle — it is meant to be) could write unlimited rows straight
-- into the database. db/schema.sql said as much and suggested Turnstile or a
-- rate-limited Worker route. This is that route: /api/access-request now does
-- the write with the service role, which bypasses RLS, after checking the
-- address is shaped like an address and that the mail caps have room.
--
-- Dropping the policy with none to replace it leaves the table with RLS on and
-- no policies at all: unreachable from the anon key in either direction.
drop policy if exists "anyone may ask" on access_requests;
