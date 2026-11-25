-- =============================================================================
-- CYCLO Phase 6 follow-up (approved 2026-11-24): remove direct self-updates.
--
-- Since Phase 1, signed-in employees could UPDATE their own full_name and
-- avatar_url straight through the Data API. Those writes skipped the Phase 4
-- avatar URL policy and were not audited. All self-service edits now go only
-- through the audited RPCs (update_my_profile, set_my_avatar, ...); Super
-- Admins keep the Phase 4 admin RPCs (including avatar_url).
--
-- Changes:
--   * revoke UPDATE on public.profiles (table and every column) from authenticated
--   * drop the now-unreachable own-row UPDATE policy
--
-- Unchanged: column SELECT grants, read RPCs, RPC owner grants and policies,
-- Auth triggers (they run as their owners), last-admin protection.
-- =============================================================================
begin;

revoke update (full_name, avatar_url) on table public.profiles from authenticated;
-- Table-level revoke also clears any column-level UPDATE that might exist.
revoke update on table public.profiles from authenticated, anon;

drop policy if exists "Active employees can update their own profile" on public.profiles;

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres only if this migration must be undone)
--
-- grant update (full_name, avatar_url) on table public.profiles to authenticated;
-- create policy "Active employees can update their own profile"
--   on public.profiles for update to authenticated
--   using (id = (select auth.uid()) and is_active)
--   with check (id = (select auth.uid()) and is_active);
-- =============================================================================
