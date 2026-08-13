// The Supabase backend. Serves both "Hisaab cloud" and "your own Supabase" —
// the only difference between them is which client is handed in, so there is
// one implementation rather than two.
//
// Everything here was lib/db.js before the backends split, and the queries are
// unchanged. That is on purpose: every user on Hisaab cloud today keeps running
// exactly the code they were running, and the new work is confined to the
// dispatcher above it and the local backend beside it.
//
// See lib/db.js for the interface this implements and for the computation that
// sits on top of it (balances, account lists, the untaught roll-up) — none of
// that is repeated per backend.

const MISSING_COLUMN = '42703'
const MISSING_TABLE = '42P01'

/**
 * @param client a @supabase/supabase-js client, ours or the user's own
 */
export function supabaseBackend(client) {
  if (!client) throw new Error('No database connection.')

  /**
   * `to_account` and `budgets.scope` only exist once db/migrate-accounts.sql
   * has run. On a database that has not run it every read and write naming them
   * comes back 42703, `undefined_column` — which is not one broken feature but
   * Today, Ledger, Insights, Review and every save at once.
   *
   * So: try it, and if the column is genuinely not there, drop it for the rest
   * of the session. Costs one failed request on an unmigrated database, nothing
   * at all on a migrated one.
   *
   * Held per backend instance rather than per module because a migration has
   * two backends open at once, and a stale source must not teach the fresh
   * target that its columns are missing.
   */
  let hasToAccount = true
  let hasScope = true

  const BASE = [
    'id', 'txn_ref', 'txn_date', 'txn_time', 'amount', 'direction', 'type',
    'payee_raw', 'payee_clean', 'category', 'subcategory', 'method', 'account',
    'source', 'confidence', 'needs_review', 'note', 'created_at',
  ]

  const COLUMNS = () => (hasToAccount ? [...BASE, 'to_account'] : BASE).join(', ')

  /**
   * Run a PostgREST call that names `to_account`, once more without it if the
   * column turns out not to exist. `run` is handed the column list so a caller
   * can build its own select; it must return the raw `{ data, error }`.
   */
  async function withToAccount(run) {
    const first = await run(COLUMNS())
    if (!first?.error || first.error.code !== MISSING_COLUMN || !hasToAccount) return first
    hasToAccount = false
    console.warn('[db] to_account is missing — run db/migrate-accounts.sql. Account balances are off until you do.')
    return run(COLUMNS())
  }

  /** Strip what the database cannot store yet, so a write survives too. */
  const writable = (row) => {
    if (hasToAccount) return row
    const { to_account, ...rest } = row
    void to_account
    return rest
  }

  /**
   * Insert rows, isolating a bad one instead of losing the batch with it.
   *
   * A multi-row insert is a single statement: one duplicate that slipped past
   * the caller's pre-check, or one row Postgres rejects for any other reason,
   * aborts all of it. Halving on a constraint error keeps the loss to the row
   * that caused it — a concurrent second upload used to take every unrelated
   * transaction in its batch down with the one row it shared.
   */
  async function insertRows(rows) {
    if (rows.length === 0) return { saved: [], rejected: 0 }

    const { data, error } = await withToAccount((cols) =>
      client.from('transactions').insert(rows.map(writable)).select(cols),
    )
    if (!error) return { saved: data ?? [], rejected: 0 }

    // Only a row-level rejection is worth isolating. Retrying a network or auth
    // failure once per row would turn one outage into hundreds of requests.
    if (!String(error.code ?? '').startsWith('23')) throw error
    if (rows.length === 1) return { saved: [], rejected: 1 }

    const mid = rows.length >> 1
    const a = await insertRows(rows.slice(0, mid))
    const b = await insertRows(rows.slice(mid))
    return { saved: [...a.saved, ...b.saved], rejected: a.rejected + b.rejected }
  }

  /**
   * PostgREST caps a response at `max-rows` — 1000 on a default Supabase
   * project — and says nothing when it does. A `.limit(3000)` was therefore not
   * a limit of 3000, it was a silent truncation at 1000 of the *oldest* rows in
   * the window, because the ordering is newest-first. Insights would then lose
   * whole months and quietly understate every total on the screen.
   *
   * Paging round it costs one extra request per 1000 rows and removes the class
   * of bug entirely. `id` is the last sort key so a page boundary can't land in
   * the middle of a tie and repeat or skip a row.
   */
  const PAGE = 1000

  async function pageThrough(limit, build) {
    const out = []
    while (out.length < limit) {
      const size = Math.min(PAGE, limit - out.length)
      const { data, error } = await withToAccount((cols) => build(out.length, size, cols))
      if (error) throw error
      out.push(...(data ?? []))
      if (!data || data.length < size) break
    }
    return out
  }

  return {
    kind: 'supabase',

    /**
     * What this database can actually store. The screens that need a column the
     * database has not got say so out loud rather than quietly computing a
     * wrong number — an account balance without `to_account` is missing every
     * transfer in, which reads as money that vanished.
     */
    capabilities: () => ({ toAccount: hasToAccount, budgetScope: hasScope }),

    async ready() {
      // One cheap round trip that touches all three tables. Enough to tell a
      // reachable, migrated project from one that is paused, unreachable, or
      // has never had the schema run.
      const tables = ['transactions', 'merchant_map', 'budgets', 'categories']
      const probes = await Promise.all(
        tables.map((t) => client.from(t).select('id', { count: 'exact', head: true })),
      )
      const missing = tables.filter((_, i) => probes[i].error)
      if (missing.length) {
        const first = probes.find((p) => p.error)?.error
        return { ok: false, missing, message: first?.message ?? 'Tables are missing.' }
      }
      return { ok: true, missing: [] }
    },

    // ── Transactions ───────────────────────────────────────────────────────

    insertTransactions: (rows) => insertRows(rows),

    listTransactions({ from, to, limit = 500 } = {}) {
      return pageThrough(limit, (offset, size, cols) => {
        let q = client.from('transactions').select(cols)
        if (from) q = q.gte('txn_date', from)
        if (to) q = q.lte('txn_date', to)
        return q
          .order('txn_date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + size - 1)
      })
    },

    /**
     * Every row, for the things computed on the device: balances, the account
     * and method lists, the untaught roll-up, an export, a migration.
     *
     * `columns` is a projection and never a filter — five columns instead of
     * twenty over five thousand rows is real bandwidth on a phone, and it is
     * the only query shaping this interface allows. Predicates stay in the
     * caller, in JavaScript, where both backends run the same code.
     */
    listAllTransactions({ limit = 5000, columns } = {}) {
      const projection = columns?.length ? columns.join(', ') : null
      return pageThrough(limit, (offset, size, cols) =>
        client
          .from('transactions')
          .select(projection ?? cols)
          .order('txn_date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + size - 1),
      )
    },

    /**
     * Which of these refs the database already holds.
     *
     * Chunked: a 400-row statement puts 400 refs in a GET query string, which
     * is long enough for PostgREST to answer 414 instead of a row list.
     */
    async findExistingRefs(refs) {
      const seen = new Set()
      for (let i = 0; i < refs.length; i += 200) {
        const { data, error } = await client
          .from('transactions')
          .select('txn_ref')
          .in('txn_ref', refs.slice(i, i + 200))
        if (error) throw error
        for (const r of data ?? []) seen.add(r.txn_ref)
      }
      return seen
    },

    async updateTransactions(ids, patch) {
      if (!ids?.length) return []
      const out = []
      // Same 414 ceiling as the ref lookup above.
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await withToAccount((cols) =>
          client
            .from('transactions')
            .update(writable(patch))
            .in('id', ids.slice(i, i + 100))
            .select(cols),
        )
        if (error) throw error
        out.push(...(data ?? []))
      }
      return out
    },

    async deleteTransactions(ids) {
      if (!ids?.length) return 0
      const { error } = await client.from('transactions').delete().in('id', ids)
      if (error) throw error
      return ids.length
    },

    async listNeedsReview() {
      const { data, error } = await withToAccount((cols) =>
        client
          .from('transactions')
          .select(`${cols}, raw_text`)
          .eq('needs_review', true)
          .order('txn_date', { ascending: false }),
      )
      if (error) throw error
      return data ?? []
    },

    async countNeedsReview() {
      const { count, error } = await client
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('needs_review', true)
      if (error) return 0
      return count ?? 0
    },

    // ── Merchant map ───────────────────────────────────────────────────────

    async listMerchantMap() {
      const { data, error } = await client
        .from('merchant_map')
        // hit_count is selected because learn() increments it. Left out,
        // `existing` was always undefined there and every write reset the
        // counter to 1, so the "what it has learned" list ordered by it never
        // moved off a flat tie.
        .select('payee_pattern, payee_clean, category, default_type, source, hit_count')
        .order('hit_count', { ascending: false })
      if (error) throw error
      return data ?? []
    },

    async upsertMerchantMapping(row, { ignoreDuplicates = false } = {}) {
      const { data, error } = await client
        .from('merchant_map')
        .upsert(row, { onConflict: 'user_id,payee_pattern', ignoreDuplicates })
        .select()
        .maybeSingle()
      if (error) throw error
      return data ?? null
    },

    async deleteMerchantMapping(payee_pattern) {
      const { error } = await client
        .from('merchant_map')
        .delete()
        .eq('payee_pattern', payee_pattern)
      if (error) throw error
    },

    // ── Budgets ────────────────────────────────────────────────────────────

    async listBudgets() {
      const { data, error } = hasScope
        ? await client.from('budgets').select('scope, category, amount')
        : await client.from('budgets').select('category, amount')
      if (error?.code === MISSING_COLUMN) {
        hasScope = false
        return this.listBudgets()
      }
      // Throws rather than returning []. A budget screen that says "No budgets
      // yet" because the network dropped is telling the user something false
      // about their own settings; the screen knows how to show a failure.
      if (error) throw error
      return (data ?? []).map((b) => ({ ...b, scope: b.scope ?? 'category' }))
    },

    async upsertBudget({ scope = 'category', category, amount }) {
      // An account cap cannot be stored without the column, and silently
      // writing it as a category budget would cap the wrong thing under the
      // same name.
      if (!hasScope && scope !== 'category') {
        throw new Error('Run db/migrate-accounts.sql — an account cap needs the scope column.')
      }
      const { error } = hasScope
        ? await client
            .from('budgets')
            .upsert({ scope, category, amount }, { onConflict: 'user_id,scope,category' })
        : await client.from('budgets').upsert({ category, amount }, { onConflict: 'user_id,category' })
      if (error?.code === MISSING_COLUMN) {
        hasScope = false
        return this.upsertBudget({ scope, category, amount })
      }
      if (error) throw error
    },

    async deleteBudget({ scope = 'category', category }) {
      let q = client.from('budgets').delete().eq('category', category)
      if (hasScope) q = q.eq('scope', scope)
      const { error } = await q
      if (error?.code === MISSING_COLUMN) {
        hasScope = false
        return this.deleteBudget({ scope, category })
      }
      if (error) throw error
    },

    // ── Categories the user made ───────────────────────────────────────────

    /**
     * Degrades to [] rather than throwing, on one specific error: a database
     * that predates this table. Everything else about the app works without it
     * — the fourteen built-ins are in the bundle — and taking every screen down
     * because someone has not re-run db/schema.sql would be a far worse failure
     * than a picker missing the categories they invented.
     */
    async listCategories() {
      const { data, error } = await client
        .from('categories')
        .select('name, color, icon')
        .order('name')
      if (error) {
        if (error.code === MISSING_TABLE || error.code === MISSING_COLUMN) {
          console.warn('[db] no categories table — run db/schema.sql. Your own categories are missing until you do.')
          return []
        }
        throw error
      }
      return data ?? []
    },

    async upsertCategory(row) {
      const { error } = await client.from('categories').upsert(row, { onConflict: 'user_id,name' })
      if (error?.code === MISSING_TABLE) {
        throw new Error('Run db/schema.sql — categories need a table of their own now.')
      }
      if (error) throw error
    },

    async deleteCategory(name) {
      const { error } = await client.from('categories').delete().eq('name', name)
      if (error && error.code !== MISSING_TABLE) throw error
    },

    // ── Wiping, for the "move it and delete the original" half of a switch ──

    /**
     * Every row this user owns, in all three tables.
     *
     * RLS scopes the delete to the caller — `using (auth.uid() = user_id)` — so
     * the `neq` below is only there because PostgREST refuses an unfiltered
     * DELETE outright. It is a syntax requirement, not the safety barrier; the
     * barrier is the policy, and on a BYO project the account is alone in the
     * database anyway.
     */
    async clear() {
      for (const table of ['transactions', 'merchant_map', 'budgets', 'categories']) {
        const { error } = await client
          .from(table)
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000')
        // A table that does not exist holds nothing, so there is nothing here
        // to fail at. Throwing would abort a move partway and leave the source
        // half-emptied, which is the one outcome this whole path avoids.
        if (error && error.code !== MISSING_TABLE) throw error
      }
    },
  }
}
