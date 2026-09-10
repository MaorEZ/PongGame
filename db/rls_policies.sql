-- ============================================================================
-- GoAgainstMe — Row Level Security lockdown
-- ============================================================================
-- WHY THIS EXISTS
--
-- The anon/publishable key `sb_publishable_wXqf6...` is embedded in
-- client/index.html, which is served to every browser. Verified by live probe
-- on 2026-09-10, that key currently has FULL read/write/delete on game_stats:
--
--   POST   /rest/v1/game_stats            -> 201 Created  (row inserted)
--   DELETE /rest/v1/game_stats?user_id=eq -> 204 No Content (row deleted)
--
-- game_stats holds `balance`. So any player can open devtools, take the key
-- out of the page source, and set their own balance to any number. For a
-- wagering game this is the whole ballgame.
--
-- FIX: game_stats / transactions / platform_fees become server-only. Enabling
-- RLS with NO policy denies all anon access. The service_role key bypasses RLS
-- entirely, so server.js keeps working — but ONLY if SUPABASE_SERVICE_KEY is a
-- real service role key. server.js (commit 2a81b8d) now requires it and prints
-- a boot banner if it is missing, so a misconfiguration is visible immediately.
--
-- ORDER OF OPERATIONS — do not skip:
--   1. Set SUPABASE_SERVICE_KEY (service role) on Render FIRST.
--   2. Confirm the boot log says `[DB] Connected: ...`.
--   3. Only then run this file.
-- Reversed, persistence stops the moment you run it.
-- ============================================================================


-- ── Server-only tables: deny all anon access ────────────────────────────────
-- RLS on with zero policies = nothing gets through except service_role.

ALTER TABLE public.game_stats     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_fees  ENABLE ROW LEVEL SECURITY;

-- Drop any permissive policies that may already exist on these.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('game_stats','transactions','platform_fees')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;


-- ── Client-facing tables: keep working, but explicitly ──────────────────────
-- client/app.js writes these directly with the anon key:
--   initPlayerDB()   -> users.upsert
--   createDBMatch()  -> users.upsert + matches.insert
--   finishDBMatch()  -> matches.update
-- These policies preserve exactly that. See the RESIDUAL RISK note below.

ALTER TABLE public.users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_users_read   ON public.users;
DROP POLICY IF EXISTS anon_users_write  ON public.users;
DROP POLICY IF EXISTS anon_users_modify ON public.users;

CREATE POLICY anon_users_read   ON public.users FOR SELECT TO anon USING (true);
CREATE POLICY anon_users_write  ON public.users FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_users_modify ON public.users FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS anon_matches_read   ON public.matches;
DROP POLICY IF EXISTS anon_matches_write  ON public.matches;
DROP POLICY IF EXISTS anon_matches_modify ON public.matches;

CREATE POLICY anon_matches_read   ON public.matches FOR SELECT TO anon USING (true);
CREATE POLICY anon_matches_write  ON public.matches FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_matches_modify ON public.matches FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Note: no DELETE policy anywhere for anon. Nothing in the client deletes.


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect rowsecurity = true on all five.
SELECT tablename, rowsecurity
FROM   pg_tables
WHERE  schemaname = 'public'
  AND  tablename IN ('game_stats','transactions','platform_fees','users','matches')
ORDER  BY tablename;

SELECT tablename, policyname, cmd, roles
FROM   pg_policies
WHERE  schemaname = 'public'
ORDER  BY tablename, policyname;


-- ============================================================================
-- RESIDUAL RISK — read before assuming this closes everything
--
-- 1. users/matches stay anon-writable because client/app.js writes them from
--    the browser. A player can still fabricate or edit match rows. This does
--    NOT touch balances, so it is not a theft vector, but it does mean the
--    `matches` table is not trustworthy as an audit log. The real fix is to
--    move those three functions server-side and drop these policies — a
--    refactor, not a policy change.
--
-- 2. There are TWO systems writing `matches` with INCOMPATIBLE id semantics:
--      client/app.js:1242  player1_id = users.id      (uuid)
--      server.js:2119      player1_id = telegram id   (string)
--    Live data confirms both shapes are present. Pre-existing; not addressed
--    here, but it means match history is already inconsistent.
--
-- 3. Rotate the anon key if you want to invalidate copies already scraped from
--    the page source. Locking RLS removes the power of that key, so this is
--    hygiene rather than urgent.
-- ============================================================================
