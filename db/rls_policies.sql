-- ============================================================================
-- GoAgainstMe - Row Level Security lockdown
-- Applied 2026-09-10 via Supabase Management API.
-- ============================================================================
-- ACTUAL STARTING STATE (measured, not assumed):
--   RLS was ALREADY enabled on every table. It was neutered by permissive
--   policies -- most notably one literally named `allow all` (cmd=ALL,
--   roles={public}) on game_stats, matches, transactions, rematches, users.
--   `public` includes `anon`, so the anon key embedded in client/index.html
--   had full read/write on `balance`. Proven live: POST -> 201, DELETE -> 204.
--
--   The policies named "Allow service role ..." were ALSO roles={public},
--   so they granted to everyone, not to service_role. Misleading names.
--
-- APPROACH: drop every existing policy, then grant back only what the client
-- provably needs. service_role bypasses RLS entirely, so server.js is
-- unaffected by having zero policies on its tables.
-- ============================================================================

-- Clean slate: drop ALL policies on the tables we manage.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('game_stats','transactions','platform_fees','rematches','users','matches')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

-- Ensure RLS is on everywhere (idempotent).
ALTER TABLE public.game_stats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rematches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches       ENABLE ROW LEVEL SECURITY;

-- ── Server-only tables: RLS on, ZERO policies = anon denied ─────────────────
-- game_stats holds `balance` -- this is the fix.
-- rematches is an orphan table: server.js keeps rematch state in an in-memory
-- Map (Database.rematches), nothing reads or writes the table.
-- (no policies created, deliberately)

-- ── Client-facing tables: only what client/app.js provably calls ────────────
--   initPlayerDB()  -> users.upsert           (SELECT + INSERT + UPDATE)
--   createDBMatch() -> users.upsert, matches.insert
--   finishDBMatch() -> matches.update
-- Scoped to the `anon` role explicitly -- not `public`, which was the bug.

CREATE POLICY anon_users_select ON public.users   FOR SELECT TO anon USING (true);
CREATE POLICY anon_users_insert ON public.users   FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_users_update ON public.users   FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY anon_matches_select ON public.matches FOR SELECT TO anon USING (true);
CREATE POLICY anon_matches_insert ON public.matches FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_matches_update ON public.matches FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- No DELETE policy anywhere for anon. Nothing in the client deletes.

-- ============================================================================
-- RESIDUAL RISK
-- 1. users/matches stay anon-writable because client/app.js writes them from
--    the browser. A player can still fabricate match rows. Not a theft vector
--    (no balances), but `matches` is not a trustworthy audit log. Real fix is
--    moving those three functions server-side, then dropping these policies.
-- 2. Two writers with incompatible id semantics on `matches`:
--      client/app.js:1242  player1_id = users.id    (uuid)
--      server.js:2119      player1_id = telegram id (string)
--    Both shapes present in live data. Pre-existing.
-- 3. Rotating the anon key is hygiene, not urgent, now that RLS constrains it.
-- ============================================================================
