-- =============================================================================
-- CYCLO Phase 7 fix H1 (approved 2026-11-24): uninvited accounts stay inactive.
--
-- Before: an Auth user created without a matching database invitation (public
-- sign-up if ever enabled, Dashboard, Admin API) got an ACTIVE DEVELOPER
-- profile and could use CYCLO immediately.
-- After:  the same account still gets the internal default DEVELOPER profile
-- (so the 1:1 auth.users -> profiles invariant and provisioning keep working),
-- but with is_active = false. It has no CYCLO access until a Super Admin
-- activates it (admin_set_employee_active) or the owner runs
-- private.provision_super_admin().
--
-- Unchanged:
--   * invitation branch (inactive + requires_onboarding until atomic completion)
--   * Auth invitations without a database invitation are still rejected
--   * user/app metadata is never read (no role or status from metadata)
--   * existing profiles: no backfill, no data change (only the trigger body)
--   * owner (postgres), SECURITY DEFINER, empty search_path, trigger binding
-- =============================================================================
begin;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare v_inv private.employee_invitations%rowtype;
begin
 select i.* into v_inv from private.employee_invitations i
  where i.email=lower(new.email) and i.status='PENDING' and i.expires_at>now() for update;
 if found then
  if v_inv.auth_user_id is not null then
   raise exception using errcode='42501',message='invalid_invitation';
  end if;
  insert into public.profiles(id,email,full_name,role,is_active,is_git_organizer,invited_by,requires_onboarding)
   values(new.id,new.email,v_inv.full_name,v_inv.assigned_role,false,false,v_inv.inviter_id,true);
  update private.employee_invitations set auth_user_id=new.id where id=v_inv.id;
 elsif new.invited_at is not null then
  raise exception using errcode='42501',message='invalid_invitation';
 else
  -- Uninvited account: default internal profile, never active by default.
  -- Role and status are fixed here; Auth metadata is deliberately ignored.
  insert into public.profiles(id,email,role,is_active,is_git_organizer)
   values(new.id,new.email,'DEVELOPER',false,false) on conflict(id) do nothing;
 end if;
 return new;
end;
$$;

comment on function private.handle_new_auth_user() is
  'auth.users insert: invited -> inactive profile pending onboarding; uninvited -> inactive DEVELOPER profile (activation by a Super Admin only). Metadata is ignored.';

revoke all on function private.handle_new_auth_user() from public, anon, authenticated, service_role;

commit;

-- =============================================================================
-- ROLLBACK (manual; restores the previous active-by-default behaviour, which
-- re-opens finding H1): re-create the function from
-- 20261121101643_employee_invitations_onboarding.sql.
-- =============================================================================
