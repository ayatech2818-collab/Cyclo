-- =============================================================================
-- CYCLO Phase 1A: employee profiles, roles and access control
--
-- Creates:
--   * schema   private                       (not exposed through the Data API)
--   * type     public.app_role
--   * table    public.profiles               (RLS + column-level grants)
--   * function private.set_updated_at()       (reusable updated_at trigger)
--   * function private.handle_new_auth_user() (auth.users insert -> profile)
--   * function private.sync_auth_user_email() (auth.users email -> profile)
--   * function private.current_app_role()     (role helper for RLS)
--   * function private.provision_super_admin() (manual first-admin bootstrap)
--
-- Privileged profile fields (role, employee_code, email, is_active,
-- is_git_organizer, invited_by, onboarded_at) can only be changed by trusted
-- server-side code (secret key / service_role) or by the database owner.
--
-- A rollback script is provided at the end of this file (commented out).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Private schema
--    Not listed in [api].schemas, so PostgREST never exposes it. Only USAGE is
--    granted, and only to roles that must evaluate RLS helpers. Nobody but the
--    owner can create or replace objects in it.
-- -----------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;
grant usage on schema private to authenticated;


-- -----------------------------------------------------------------------------
-- 2. Role enum
--    Git Organizer is deliberately NOT a role; see profiles.is_git_organizer.
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('SUPER_ADMIN', 'PROJECT_MANAGER', 'DEVELOPER');

comment on type public.app_role is
  'CYCLO employee role. Git Organizer is a separate permission flag on profiles.';


-- -----------------------------------------------------------------------------
-- 3. Profiles table
-- -----------------------------------------------------------------------------
create table public.profiles (
  id               uuid        primary key
                               references auth.users (id) on delete cascade,
  email            text,
  full_name        text,
  employee_code    text,
  role             public.app_role not null default 'DEVELOPER',
  is_active        boolean     not null default true,
  is_git_organizer boolean     not null default false,
  avatar_url       text,
  -- SET NULL so that removing an inviter's auth user never blocks deletion.
  invited_by       uuid        references public.profiles (id) on delete set null,
  onboarded_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Unique when provided; NULLs are allowed during invitation/onboarding.
  constraint profiles_employee_code_key unique (employee_code),
  constraint profiles_employee_code_not_blank check (
    employee_code is null
    or (employee_code = btrim(employee_code) and char_length(employee_code) between 1 and 32)
  ),
  constraint profiles_full_name_not_blank check (
    full_name is null or char_length(btrim(full_name)) between 1 and 200
  ),
  constraint profiles_avatar_url_https check (
    avatar_url is null or (avatar_url ~* '^https://' and char_length(avatar_url) <= 2048)
  ),
  constraint profiles_invited_by_not_self check (invited_by is null or invited_by <> id)
);

comment on table public.profiles is
  'One row per CYCLO employee, 1:1 with auth.users. Deactivate with is_active; do not delete.';
comment on column public.profiles.email is
  'Copied from auth.users by trigger. Read-only for employees.';
comment on column public.profiles.is_git_organizer is
  'Permission flag, independent of role.';
comment on column public.profiles.onboarded_at is
  'Set once the invited employee has set a password and completed their profile.';

create index profiles_email_lower_idx on public.profiles (lower(email));
create index profiles_invited_by_idx  on public.profiles (invited_by);


-- -----------------------------------------------------------------------------
-- 4. Reusable updated_at trigger
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function private.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. Auth user -> profile triggers
--
--    Runs as the function owner (SECURITY DEFINER) because auth.users rows are
--    inserted by supabase_auth_admin, which has no rights on public.profiles.
--    Works for inviteUserByEmail, dashboard-created users and admin.createUser.
--
--    raw_user_meta_data and raw_app_meta_data are intentionally ignored: the
--    profile always starts as an active DEVELOPER with no Git Organizer
--    permission. Elevated roles are granted later by trusted server code.
-- -----------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role, is_active, is_git_organizer)
  values (new.id, new.email, 'DEVELOPER', true, false)
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated, service_role;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_auth_user();


create function private.sync_auth_user_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set email = new.email
   where id = new.id;

  return new;
end;
$$;

revoke all on function private.sync_auth_user_email() from public, anon, authenticated, service_role;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function private.sync_auth_user_email();


-- -----------------------------------------------------------------------------
-- 6. Role helper
--
--    SECURITY DEFINER so it reads profiles without re-entering profiles' RLS
--    policies (prevents infinite recursion). Returns NULL when the caller is
--    unauthenticated, has no profile, or is inactive.
--    search_path is empty, so every reference is schema-qualified.
-- -----------------------------------------------------------------------------
create function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
    from public.profiles as p
   where p.id = (select auth.uid())
     and p.is_active
$$;

comment on function private.current_app_role() is
  'Role of the calling user, or NULL if unauthenticated, missing profile, or inactive.';

revoke all on function private.current_app_role() from public, anon, service_role;
grant execute on function private.current_app_role() to authenticated;


-- -----------------------------------------------------------------------------
-- 7. First Super Admin provisioning (manual, controlled)
--
--    Only the database owner can run this (e.g. from the SQL editor or psql
--    as postgres). It is not executable by any API role and lives in the
--    non-exposed private schema, so it cannot be reached over HTTP.
--
--    Usage, after creating/inviting the user through Supabase Auth:
--      select private.provision_super_admin('person@example.com');
-- -----------------------------------------------------------------------------
create function private.provision_super_admin(target_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
  match_count integer;
begin
  if target_email is null or btrim(target_email) = '' then
    raise exception 'target_email is required';
  end if;

  select count(*), min(p.id::text)::uuid
    into match_count, target_id
    from public.profiles as p
   where lower(p.email) = lower(btrim(target_email));

  if match_count = 0 then
    raise exception 'No profile found for that email. Create the auth user first.';
  elsif match_count > 1 then
    raise exception 'Email matches more than one profile; resolve manually.';
  end if;

  update public.profiles
     set role = 'SUPER_ADMIN',
         is_active = true
   where id = target_id;

  return target_id;
end;
$$;

revoke all on function private.provision_super_admin(text) from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 8. Table privileges
--
--    Start from zero (revoking table-level UPDATE also removes any column-level
--    UPDATE), then grant exactly what is needed. RLS restricts rows; these
--    grants restrict columns and operations.
-- -----------------------------------------------------------------------------
revoke all on table public.profiles from public, anon, authenticated, service_role;

-- Employees: read (rows filtered by RLS); update only self-service columns.
grant select on table public.profiles to authenticated;
grant update (full_name, avatar_url) on table public.profiles to authenticated;

-- Trusted server-side administration (secret key). service_role bypasses RLS.
grant select, insert, update, delete on table public.profiles to service_role;


-- -----------------------------------------------------------------------------
-- 9. Row Level Security
--    Enabled explicitly; the project's ensure_rls event trigger also does this
--    on hosted projects, and enabling twice is harmless.
--    No INSERT or DELETE policies exist, so both are denied for API roles
--    (profiles are created by trigger; employees are deactivated, not deleted).
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "Employees can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

create policy "Active super admins can read all profiles"
  on public.profiles
  for select
  to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');

create policy "Active employees can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()) and is_active)
  with check (id = (select auth.uid()) and is_active);


-- =============================================================================
-- ROLLBACK (manual; run as postgres only if this migration must be undone).
-- Supabase CLI migrations are forward-only, so this is not executed
-- automatically. Dropping profiles deletes all profile data.
--
-- drop trigger if exists on_auth_user_email_updated on auth.users;
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop table if exists public.profiles;
-- drop function if exists private.provision_super_admin(text);
-- drop function if exists private.current_app_role();
-- drop function if exists private.sync_auth_user_email();
-- drop function if exists private.handle_new_auth_user();
-- drop function if exists private.set_updated_at();
-- drop type if exists public.app_role;
-- drop schema if exists private;  -- only if nothing else uses it
-- =============================================================================
