-- =============================================================================
-- CYCLO Phase 2: secure employee read RPCs
--
-- Creates:
--   * role     cyclo_employee_api                NOLOGIN owner of read RPCs
--   * function private.request_user_id()          auth.uid() bridge (owner: postgres)
--   * function private.require_employee_actor()   in-database authorization
--   * function private.list_employees(...)        directory page   (SA, PM)
--   * function private.get_employee(uuid)         directory detail (SA, PM)
--   * function private.admin_get_employee(uuid)   admin detail     (SA)
--   * function private.get_my_profile()           own profile      (any active)
--   * function public.<same names>                SECURITY INVOKER RPC wrappers
--
-- Changes:
--   * authenticated: table-level SELECT on public.profiles is replaced by a
--     column-level SELECT on the non-administrative columns only.
--
-- Unchanged: existing RLS policies, own-profile UPDATE (full_name, avatar_url),
-- profile triggers, and the last-active-Super-Admin protection.
--
-- Security model
--   * Every RPC resolves the caller from the verified JWT (auth.uid()); no
--     function accepts an actor id or role.
--   * Authorization is enforced inside the database, re-reading the caller's
--     profile on every call (inactive callers are rejected).
--   * Each RPC returns an explicit column list, never SETOF public.profiles.
--   * SECURITY DEFINER code lives in the non-exposed private schema, is owned by
--     a NOLOGIN role with SELECT-only access, uses an empty search_path and
--     schema-qualifies every object. No login role is a member of it.
--
-- Error contract (SQLSTATE / message)
--   42501 'unauthenticated' | 'forbidden'   -> HTTP 401/403 through PostgREST
--   22023 'invalid_<parameter>'             -> HTTP 400
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Dedicated function-owner role
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cyclo_employee_api') then
    create role cyclo_employee_api nologin;
  end if;
end;
$$;

alter role cyclo_employee_api nologin noinherit nocreatedb nocreaterole;

-- Fail closed if a pre-existing role of this name carries elevated attributes
-- (only a superuser could grant them, and postgres cannot remove them).
do $$
begin
  if exists (
    select 1
      from pg_catalog.pg_roles
     where rolname = 'cyclo_employee_api'
       and (rolsuper or rolreplication or rolbypassrls or rolcanlogin)
  ) then
    raise exception 'cyclo_employee_api has unexpected privileges; resolve manually.';
  end if;
end;
$$;

comment on role cyclo_employee_api is
  'CYCLO: owner of employee read RPCs. NOLOGIN; must never be granted to login roles.';

revoke all on schema private from cyclo_employee_api;
grant usage on schema private to cyclo_employee_api;

-- Read-only. Write access is not granted to this role.
revoke all on table public.profiles from cyclo_employee_api;
grant select on table public.profiles to cyclo_employee_api;

-- cyclo_employee_api is not BYPASSRLS, so it needs its own policy. Only
-- functions owned by this role run as it; each one authorizes the caller first.
create policy "Employee API role reads profiles for authorized RPCs"
  on public.profiles
  for select
  to cyclo_employee_api
  using (true);


-- -----------------------------------------------------------------------------
-- 2. Caller identity bridge
--
--    postgres cannot grant USAGE on the auth schema, so the owner role cannot
--    call auth.uid() itself. This postgres-owned helper does it on the
--    owner role's behalf and is executable by that role only.
-- -----------------------------------------------------------------------------
create function private.request_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;

comment on function private.request_user_id() is
  'auth.uid() of the current request. Executable only by cyclo_employee_api.';

revoke all on function private.request_user_id() from public, anon, authenticated, service_role;
grant execute on function private.request_user_id() to cyclo_employee_api;


-- -----------------------------------------------------------------------------
-- 3. Authorization helper
-- -----------------------------------------------------------------------------
create function private.require_employee_actor(p_allowed_roles public.app_role[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.request_user_id();
  v_role public.app_role;
  v_active boolean;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  select p.role, p.is_active
    into v_role, v_active
    from public.profiles as p
   where p.id = v_actor_id;

  if not found
     or not v_active
     or p_allowed_roles is null
     or not (v_role = any (p_allowed_roles)) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  return v_actor_id;
end;
$$;

comment on function private.require_employee_actor(public.app_role[]) is
  'Returns auth.uid() when the caller has an active profile with an allowed role; raises 42501 otherwise.';


-- -----------------------------------------------------------------------------
-- 4. Directory listing (SUPER_ADMIN, PROJECT_MANAGER)
--
--    Search is a trimmed, length-limited substring match on full name, email
--    and employee code. LIKE wildcards in the input are escaped, so the input
--    is always treated literally. Sorting is fixed and stable.
-- -----------------------------------------------------------------------------
create function private.list_employees(
  p_search text,
  p_role public.app_role,
  p_is_active boolean,
  p_page integer,
  p_page_size integer
)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_search text := nullif(pg_catalog.btrim(p_search), '');
  v_pattern text;
begin
  perform private.require_employee_actor(
    array['SUPER_ADMIN', 'PROJECT_MANAGER']::public.app_role[]
  );

  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;

  if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;

    v_pattern := '%' || pg_catalog.replace(
                          pg_catalog.replace(
                            pg_catalog.replace(v_search, '\', '\\'),
                          '%', '\%'),
                        '_', '\_') || '%';
  end if;

  return query
    select p.id,
           p.full_name,
           p.avatar_url,
           p.email,
           p.employee_code,
           p.role,
           p.is_active,
           pg_catalog.count(*) over ()
      from public.profiles as p
     where (p_role is null or p.role = p_role)
       and (p_is_active is null or p.is_active = p_is_active)
       and (
         v_pattern is null
         or p.full_name     operator(pg_catalog.~~*) v_pattern
         or p.email         operator(pg_catalog.~~*) v_pattern
         or p.employee_code operator(pg_catalog.~~*) v_pattern
       )
     order by pg_catalog.lower(p.full_name) asc nulls last,
              pg_catalog.lower(p.email) asc nulls last,
              p.id asc
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. Directory detail (SUPER_ADMIN, PROJECT_MANAGER)
-- -----------------------------------------------------------------------------
create function private.get_employee(p_employee_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_employee_actor(
    array['SUPER_ADMIN', 'PROJECT_MANAGER']::public.app_role[]
  );

  if p_employee_id is null then
    raise exception using errcode = '22023', message = 'invalid_employee_id';
  end if;

  return query
    select p.id, p.full_name, p.avatar_url, p.email, p.employee_code, p.role, p.is_active
      from public.profiles as p
     where p.id = p_employee_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Administrative detail (SUPER_ADMIN only)
-- -----------------------------------------------------------------------------
create function private.admin_get_employee(p_employee_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  is_git_organizer boolean,
  invited_by uuid,
  invited_by_name text,
  onboarded_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_employee_actor(array['SUPER_ADMIN']::public.app_role[]);

  if p_employee_id is null then
    raise exception using errcode = '22023', message = 'invalid_employee_id';
  end if;

  return query
    select p.id,
           p.full_name,
           p.avatar_url,
           p.email,
           p.employee_code,
           p.role,
           p.is_active,
           p.is_git_organizer,
           p.invited_by,
           coalesce(inviter.full_name, inviter.email),
           p.onboarded_at,
           p.created_at,
           p.updated_at
      from public.profiles as p
      left join public.profiles as inviter on inviter.id = p.invited_by
     where p.id = p_employee_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. Own profile (any active employee)
-- -----------------------------------------------------------------------------
create function private.get_my_profile()
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  is_git_organizer boolean,
  onboarded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
begin
  v_actor_id := private.require_employee_actor(
    array['SUPER_ADMIN', 'PROJECT_MANAGER', 'DEVELOPER']::public.app_role[]
  );

  return query
    select p.id, p.full_name, p.avatar_url, p.email, p.employee_code, p.role,
           p.is_active, p.is_git_organizer, p.onboarded_at
      from public.profiles as p
     where p.id = v_actor_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Ownership and EXECUTE privileges for the private implementations
--
--    PostgreSQL 16+ requires the migration role to be able to SET ROLE to the
--    new owner, and the new owner to have CREATE on the schema. Both are
--    granted only for the transfer and revoked at the end of this section.
--    EXECUTE privileges are managed as the owner, before membership is revoked.
--
--    Afterwards postgres keeps only the automatic CREATEROLE grant
--    (ADMIN OPTION, without INHERIT or SET): it can administer membership
--    but cannot act as cyclo_employee_api. Future migrations that replace these
--    functions repeat the temporary grant/revoke pattern.
-- -----------------------------------------------------------------------------
grant cyclo_employee_api to postgres with inherit false, set true;
grant create on schema private to cyclo_employee_api;

alter function private.require_employee_actor(public.app_role[]) owner to cyclo_employee_api;
alter function private.list_employees(text, public.app_role, boolean, integer, integer) owner to cyclo_employee_api;
alter function private.get_employee(uuid) owner to cyclo_employee_api;
alter function private.admin_get_employee(uuid) owner to cyclo_employee_api;
alter function private.get_my_profile() owner to cyclo_employee_api;

set role cyclo_employee_api;

revoke all on function private.require_employee_actor(public.app_role[]) from public, anon, authenticated, service_role;
revoke all on function private.list_employees(text, public.app_role, boolean, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.get_employee(uuid) from public, anon, authenticated, service_role;
revoke all on function private.admin_get_employee(uuid) from public, anon, authenticated, service_role;
revoke all on function private.get_my_profile() from public, anon, authenticated, service_role;

-- Reachable only through the public wrappers: the private schema is not
-- exposed by the Data API.
grant execute on function private.list_employees(text, public.app_role, boolean, integer, integer) to authenticated;
grant execute on function private.get_employee(uuid) to authenticated;
grant execute on function private.admin_get_employee(uuid) to authenticated;
grant execute on function private.get_my_profile() to authenticated;

reset role;

revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;


-- -----------------------------------------------------------------------------
-- 9. Public RPC wrappers (SECURITY INVOKER, exposed through the Data API)
-- -----------------------------------------------------------------------------
create function public.list_employees(
  p_search text default null,
  p_role public.app_role default null,
  p_is_active boolean default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.total_count
    from private.list_employees(p_search, p_role, p_is_active, p_page, p_page_size) as e
$$;

create function public.get_employee(p_employee_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active
    from private.get_employee(p_employee_id) as e
$$;

create function public.admin_get_employee(p_employee_id uuid)
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  is_git_organizer boolean,
  invited_by uuid,
  invited_by_name text,
  onboarded_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active,
         e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at,
         e.created_at, e.updated_at
    from private.admin_get_employee(p_employee_id) as e
$$;

create function public.get_my_profile()
returns table (
  id uuid,
  full_name text,
  avatar_url text,
  email text,
  employee_code text,
  role public.app_role,
  is_active boolean,
  is_git_organizer boolean,
  onboarded_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role,
         e.is_active, e.is_git_organizer, e.onboarded_at
    from private.get_my_profile() as e
$$;

-- Supabase default privileges grant EXECUTE on new public functions to anon,
-- authenticated and service_role. Reset, then grant to signed-in users only.
revoke all on function public.list_employees(text, public.app_role, boolean, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_employee(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_employee(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_profile() from public, anon, authenticated, service_role;

grant execute on function public.list_employees(text, public.app_role, boolean, integer, integer) to authenticated;
grant execute on function public.get_employee(uuid) to authenticated;
grant execute on function public.admin_get_employee(uuid) to authenticated;
grant execute on function public.get_my_profile() to authenticated;

comment on function public.list_employees(text, public.app_role, boolean, integer, integer) is
  'Employee directory page. Active SUPER_ADMIN or PROJECT_MANAGER only.';
comment on function public.get_employee(uuid) is
  'Employee directory detail. Active SUPER_ADMIN or PROJECT_MANAGER only.';
comment on function public.admin_get_employee(uuid) is
  'Administrative employee detail. Active SUPER_ADMIN only.';
comment on function public.get_my_profile() is
  'Calling employee''s own profile. Any active employee.';


-- -----------------------------------------------------------------------------
-- 10. Narrow direct table reads
--
--     Revoking table-level SELECT also removes column-level SELECT; UPDATE
--     (full_name, avatar_url) is a separate privilege and is not affected.
--     The remaining columns cover the existing auth projection
--     (id, full_name, email, role, is_active). Administrative columns are only
--     available through the RPCs above.
-- -----------------------------------------------------------------------------
revoke select on table public.profiles from authenticated;

grant select (id, email, full_name, avatar_url, employee_code, role, is_active)
  on table public.profiles to authenticated;


-- =============================================================================
-- ROLLBACK (manual; run as postgres only if this migration must be undone)
--
-- grant select on table public.profiles to authenticated;
-- drop function if exists public.get_my_profile();
-- drop function if exists public.admin_get_employee(uuid);
-- drop function if exists public.get_employee(uuid);
-- drop function if exists public.list_employees(text, public.app_role, boolean, integer, integer);
-- grant cyclo_employee_api to postgres with inherit false, set true;
-- drop function if exists private.get_my_profile();
-- drop function if exists private.admin_get_employee(uuid);
-- drop function if exists private.get_employee(uuid);
-- drop function if exists private.list_employees(text, public.app_role, boolean, integer, integer);
-- drop function if exists private.require_employee_actor(public.app_role[]);
-- revoke cyclo_employee_api from postgres;
-- drop function if exists private.request_user_id();
-- drop policy if exists "Employee API role reads profiles for authorized RPCs" on public.profiles;
-- revoke all on table public.profiles from cyclo_employee_api;
-- revoke all on schema private from cyclo_employee_api;
-- drop role if exists cyclo_employee_api;
-- =============================================================================
