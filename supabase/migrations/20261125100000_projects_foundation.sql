-- =============================================================================
-- CYCLO Phase 8A: project foundation (local deployment only)
--
-- Creates:
--   * types    public.project_status, public.project_priority
--   * table    public.projects                 (RLS, no hard deletes)
--   * table    private.project_audit_log       (append-only, RPC owner inserts)
--   * role     cyclo_project_api               NOLOGIN owner of project RPCs
--   * triggers projects_set_updated_at, projects_guard_row, projects_prevent_delete
--   * RPCs     (public SECURITY INVOKER wrappers over private SECURITY DEFINER
--              implementations owned by cyclo_project_api):
--       list_projects(...)                   SA: all · PM: assigned · DEV: none yet
--       get_project(uuid)                    same visibility; zero rows otherwise
--       list_project_manager_options()       SA only: active Project Managers
--       create_project(...)                  SA (chooses PM) · PM (becomes PM)
--       update_project(...)                  SA · assigned PM (not archived)
--       assign_project_manager(uuid, uuid)   SA only
--       archive_project(uuid)                SA · assigned PM
--       restore_project(uuid)                SA · assigned PM
--
-- Business rules enforced in the database
--   * Every project has exactly one PM (NOT NULL FK). Whenever the PM is set or
--     changed, the PM must be an ACTIVE profile with role PROJECT_MANAGER
--     (trigger, so it holds for every writer, including service_role).
--   * A PM creating a project always becomes its PM; a client-supplied PM id
--     other than the caller is rejected. Only a Super Admin assigns/reassigns.
--   * project_key is unique, upper-case, 2-10 chars, and immutable after
--     creation (future work-item keys will be derived from it).
--   * start_date <= target_date (CHECK).
--   * No DELETE/TRUNCATE for anyone (privileges + trigger). Archive instead.
--   * Developers see no projects until project membership exists (Phase 8B).
--
-- Unchanged: profiles columns, grants, policies and triggers; all employee,
-- invitation, onboarding and avatar RPCs. Additive only: a SELECT policy on
-- public.profiles for the new NOLOGIN owner role, and EXECUTE on
-- private.request_user_id() for that role.
--
-- Error contract (SQLSTATE / message)
--   42501 'unauthenticated' | 'forbidden'
--   P0002 'project_not_found'             (also when the caller cannot see it)
--   23505 'duplicate_project_key'
--   55000 'project_archived'
--   22023 'invalid_<field>' | 'invalid_date_range' | 'invalid_project_manager'
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Enums
--    project_priority is declared in ascending order so ORDER BY sorts by rank.
-- -----------------------------------------------------------------------------
create type public.project_status as enum ('planning', 'active', 'on_hold', 'completed', 'cancelled');
create type public.project_priority as enum ('low', 'medium', 'high', 'critical');

comment on type public.project_status is 'CYCLO project lifecycle status.';
comment on type public.project_priority is 'CYCLO project priority, ascending.';


-- -----------------------------------------------------------------------------
-- 2. Projects table
-- -----------------------------------------------------------------------------
create table public.projects (
  id                 uuid        primary key default gen_random_uuid(),
  name               text        not null,
  project_key        text        not null,
  description        text,
  status             public.project_status   not null default 'planning',
  priority           public.project_priority not null default 'medium',
  -- RESTRICT: profiles are deactivated, never deleted; a project never loses its PM.
  project_manager_id uuid        not null references public.profiles (id) on delete restrict,
  start_date         date,
  target_date        date,
  created_by         uuid        not null references public.profiles (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  archived_at        timestamptz,

  constraint projects_project_key_key unique (project_key),
  constraint projects_project_key_format check (project_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint projects_name_valid check (
    name = btrim(name) and char_length(name) between 2 and 120 and name !~ '[[:cntrl:]]'
  ),
  constraint projects_description_valid check (
    description is null or (char_length(btrim(description)) between 1 and 5000)
  ),
  constraint projects_dates_ordered check (
    start_date is null or target_date is null or start_date <= target_date
  ),
  constraint projects_archived_after_created check (archived_at is null or archived_at >= created_at)
);

comment on table public.projects is
  'CYCLO projects. Archive with archived_at; hard deletion is blocked. Writes only through project RPCs.';
comment on column public.projects.project_key is
  'Unique upper-case key (2-10 chars, letter first). Immutable after creation.';
comment on column public.projects.project_manager_id is
  'Exactly one assigned Project Manager: an active PROJECT_MANAGER whenever set or changed.';

create index projects_project_manager_id_idx on public.projects (project_manager_id);
create index projects_created_by_idx         on public.projects (created_by);
create index projects_status_idx             on public.projects (status);
create index projects_archived_updated_idx   on public.projects ((archived_at is null), updated_at desc);
create index projects_name_lower_idx         on public.projects (lower(name));


-- -----------------------------------------------------------------------------
-- 3. Row triggers
-- -----------------------------------------------------------------------------
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function private.set_updated_at();

-- Owner: postgres (reads profiles regardless of the writer's privileges).
create function private.guard_project_row()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
begin
  if TG_OP = 'UPDATE' then
    if new.project_key is distinct from old.project_key then
      raise exception using errcode = '22023', message = 'project_key_immutable';
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception using errcode = '22023', message = 'project_origin_immutable';
    end if;
  end if;

  if TG_OP = 'INSERT' or new.project_manager_id is distinct from old.project_manager_id then
    if not exists (
      select 1
        from public.profiles as p
       where p.id = new.project_manager_id
         and p.is_active
         and p.role = 'PROJECT_MANAGER'::public.app_role
    ) then
      raise exception using
        errcode = '23514',
        message = 'invalid_project_manager',
        constraint = 'projects_project_manager_valid',
        schema = 'public',
        table = 'projects';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.guard_project_row() from public, anon, authenticated, service_role;

create trigger projects_guard_row
  before insert or update on public.projects
  for each row
  execute function private.guard_project_row();

create function private.prevent_project_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '23514',
    message = 'Projects cannot be deleted. Archive the project instead.',
    constraint = 'projects_no_delete';
end;
$$;

revoke all on function private.prevent_project_delete() from public, anon, authenticated, service_role;

create trigger projects_prevent_delete
  before delete on public.projects
  for each row
  execute function private.prevent_project_delete();

create trigger projects_prevent_truncate
  before truncate on public.projects
  for each statement
  execute function private.prevent_project_delete();

alter table public.projects enable always trigger projects_guard_row;
alter table public.projects enable always trigger projects_prevent_delete;
alter table public.projects enable always trigger projects_prevent_truncate;


-- -----------------------------------------------------------------------------
-- 4. Audit log (append-only; read access arrives with the Activity section)
-- -----------------------------------------------------------------------------
create table private.project_audit_log (
  id          uuid        primary key default gen_random_uuid(),
  actor_id    uuid        not null,
  project_id  uuid        not null,
  action      text        not null check (action in (
    'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
    'PROJECT_ARCHIVED', 'PROJECT_RESTORED')),
  old_values  jsonb       not null check (jsonb_typeof(old_values) = 'object'),
  new_values  jsonb       not null check (jsonb_typeof(new_values) = 'object'),
  created_at  timestamptz not null default now()
);

comment on table private.project_audit_log is
  'Append-only project audit. UUIDs intentionally survive profile changes; only changed business fields are recorded.';

create index project_audit_log_project_created_idx on private.project_audit_log (project_id, created_at desc);

alter table private.project_audit_log enable row level security;
revoke all on private.project_audit_log from public, anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 5. Dedicated NOLOGIN owner role for project RPCs
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'cyclo_project_api') then
    create role cyclo_project_api nologin;
  end if;
end;
$$;

alter role cyclo_project_api nologin noinherit nocreatedb nocreaterole;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_roles
     where rolname = 'cyclo_project_api'
       and (rolsuper or rolreplication or rolbypassrls or rolcanlogin)
  ) then
    raise exception 'cyclo_project_api has unexpected privileges; resolve manually.';
  end if;
end;
$$;

comment on role cyclo_project_api is
  'CYCLO: owner of project RPCs. NOLOGIN, no BYPASSRLS; never grant to login roles.';

revoke all on schema private from cyclo_project_api;
grant usage on schema private to cyclo_project_api;

grant execute on function private.request_user_id() to cyclo_project_api;

-- Profiles: read the fields needed for authorization and PM display only.
revoke all on table public.profiles from cyclo_project_api;
grant select (id, full_name, email, role, is_active) on table public.profiles to cyclo_project_api;
create policy "Project API role reads profiles for authorized RPCs"
  on public.profiles
  for select
  to cyclo_project_api
  using (true);

-- Projects: project_key, created_by and created_at are never updatable.
revoke all on table public.projects from public, anon, authenticated, service_role, cyclo_project_api;
grant select on table public.projects to cyclo_project_api;
grant insert (name, project_key, description, status, priority, project_manager_id,
              start_date, target_date, created_by)
  on table public.projects to cyclo_project_api;
grant update (name, description, status, priority, project_manager_id,
              start_date, target_date, archived_at)
  on table public.projects to cyclo_project_api;

create policy "Project API role reads projects for authorized RPCs"
  on public.projects for select to cyclo_project_api using (true);
create policy "Project API role inserts projects for authorized RPCs"
  on public.projects for insert to cyclo_project_api with check (true);
create policy "Project API role updates projects for authorized RPCs"
  on public.projects for update to cyclo_project_api using (true) with check (true);

grant insert (actor_id, project_id, action, old_values, new_values)
  on private.project_audit_log to cyclo_project_api;
create policy project_api_append_audit on private.project_audit_log
  for insert to cyclo_project_api
  with check (actor_id = private.request_user_id());


-- -----------------------------------------------------------------------------
-- 6. Direct table access for signed-in employees: read-only, row-filtered.
--    Writes are only possible through the RPCs below.
-- -----------------------------------------------------------------------------
alter table public.projects enable row level security;

grant select on table public.projects to authenticated;
-- Trusted server tooling may read and repair, but never delete.
grant select, insert, update on table public.projects to service_role;

create policy "Super admins read all projects"
  on public.projects
  for select
  to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');

create policy "Project managers read assigned projects"
  on public.projects
  for select
  to authenticated
  using (
    project_manager_id = (select auth.uid())
    and (select private.current_app_role()) = 'PROJECT_MANAGER'
  );


-- -----------------------------------------------------------------------------
-- 7. Private implementations (SECURITY DEFINER, owner cyclo_project_api)
-- -----------------------------------------------------------------------------

-- Caller identity and role, re-read on every call. Inactive callers are rejected.
create function private.project_actor(out actor_id uuid, out actor_role public.app_role)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  actor_id := private.request_user_id();
  if actor_id is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  select p.role into actor_role
    from public.profiles as p
   where p.id = actor_id
     and p.is_active;

  if not found then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

create function private.trim_text(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.regexp_replace(p_value, '^[[:space:]]+|[[:space:]]+$', '', 'g')
$$;

create function private.is_active_project_manager(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles as p
     where p.id = p_profile_id
       and p.is_active
       and p.role = 'PROJECT_MANAGER'::public.app_role
  )
$$;

-- Validates and normalizes editable fields; raises 22023 on invalid input.
create function private.validate_project_fields(
  p_name text,
  p_description text,
  p_priority public.project_priority,
  p_start_date date,
  p_target_date date,
  out v_name text,
  out v_description text
)
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  v_name := private.trim_text(p_name);
  if v_name is null
     or pg_catalog.char_length(v_name) not between 2 and 120
     or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;

  v_description := nullif(private.trim_text(p_description), '');
  if v_description is not null and pg_catalog.char_length(v_description) > 5000 then
    raise exception using errcode = '22023', message = 'invalid_description';
  end if;

  if p_priority is null then
    raise exception using errcode = '22023', message = 'invalid_priority';
  end if;

  if p_start_date is not null and p_target_date is not null and p_start_date > p_target_date then
    raise exception using errcode = '22023', message = 'invalid_date_range';
  end if;
end;
$$;

-- Locks the project and authorizes a manager-level change.
-- SA: any project. PM: only projects assigned to them. Others: forbidden.
-- Projects the caller cannot see are reported as not found.
create function private.lock_managed_project(p_project_id uuid, out actor_id uuid, out actor_role public.app_role)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pm uuid;
begin
  select a.actor_id, a.actor_role into actor_id, actor_role from private.project_actor() as a;

  if actor_role not in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;

  select pr.project_manager_id into v_pm
    from public.projects as pr
   where pr.id = p_project_id
     for update;

  if not found or (actor_role = 'PROJECT_MANAGER'::public.app_role and v_pm <> actor_id) then
    raise exception using errcode = 'P0002', message = 'project_not_found';
  end if;

  -- Re-check after waiting for the row lock: role/status may have changed.
  select a.actor_id, a.actor_role into actor_id, actor_role from private.project_actor() as a;
  if actor_role not in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role)
     or (actor_role = 'PROJECT_MANAGER'::public.app_role and v_pm <> actor_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

-- Keeps only keys whose value changed (for audit rows).
create function private.jsonb_changed(p_old jsonb, p_new jsonb, out old_values jsonb, out new_values jsonb)
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_object_agg(n.key, p_old -> n.key), '{}'::jsonb),
         coalesce(pg_catalog.jsonb_object_agg(n.key, n.value), '{}'::jsonb)
    from pg_catalog.jsonb_each(p_new) as n
   where (p_old -> n.key) is distinct from n.value
$$;


create function private.list_projects(
  p_search text,
  p_status public.project_status,
  p_priority public.project_priority,
  p_archived boolean,
  p_sort text,
  p_page integer,
  p_page_size integer
)
returns table (
  id uuid,
  name text,
  project_key text,
  description text,
  status public.project_status,
  priority public.project_priority,
  project_manager_id uuid,
  project_manager_name text,
  start_date date,
  target_date date,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_role public.app_role;
  v_search text := nullif(private.trim_text(p_search), '');
  v_pattern text;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from private.project_actor() as a;

  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;
  if p_archived is null then
    raise exception using errcode = '22023', message = 'invalid_archived';
  end if;
  if p_sort is null or p_sort not in ('updated_desc', 'created_desc', 'created_asc', 'name_asc',
                                      'name_desc', 'target_asc', 'priority_desc') then
    raise exception using errcode = '22023', message = 'invalid_sort';
  end if;
  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- Developers: no project membership exists yet, so no project is visible.
  if v_role = 'DEVELOPER'::public.app_role then
    return;
  end if;

  return query
    select pr.id, pr.name, pr.project_key, pr.description, pr.status, pr.priority,
           pr.project_manager_id,
           coalesce(pm.full_name, pm.email),
           pr.start_date, pr.target_date, pr.created_at, pr.updated_at, pr.archived_at,
           pg_catalog.count(*) over ()
      from public.projects as pr
      join public.profiles as pm on pm.id = pr.project_manager_id
     where (v_role = 'SUPER_ADMIN'::public.app_role or pr.project_manager_id = v_actor)
       and (case when p_archived then pr.archived_at is not null else pr.archived_at is null end)
       and (p_status is null or pr.status = p_status)
       and (p_priority is null or pr.priority = p_priority)
       and (
         v_pattern is null
         or pr.name        operator(pg_catalog.~~*) v_pattern
         or pr.project_key operator(pg_catalog.~~*) v_pattern
       )
     order by
       case when p_sort = 'name_asc'      then pg_catalog.lower(pr.name) end asc,
       case when p_sort = 'name_desc'     then pg_catalog.lower(pr.name) end desc,
       case when p_sort = 'created_desc'  then pr.created_at end desc,
       case when p_sort = 'created_asc'   then pr.created_at end asc,
       case when p_sort = 'target_asc'    then pr.target_date end asc nulls last,
       case when p_sort = 'priority_desc' then pr.priority end desc,
       pr.updated_at desc,
       pr.id asc
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;


create function private.get_project(p_project_id uuid)
returns table (
  id uuid,
  name text,
  project_key text,
  description text,
  status public.project_status,
  priority public.project_priority,
  project_manager_id uuid,
  project_manager_name text,
  project_manager_email text,
  project_manager_is_active boolean,
  start_date date,
  target_date date,
  created_by uuid,
  created_by_name text,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_role public.app_role;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from private.project_actor() as a;

  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;

  if v_role = 'DEVELOPER'::public.app_role then
    return;
  end if;

  return query
    select pr.id, pr.name, pr.project_key, pr.description, pr.status, pr.priority,
           pr.project_manager_id,
           coalesce(pm.full_name, pm.email),
           pm.email,
           (pm.is_active and pm.role = 'PROJECT_MANAGER'::public.app_role),
           pr.start_date, pr.target_date,
           pr.created_by,
           coalesce(cb.full_name, cb.email),
           pr.created_at, pr.updated_at, pr.archived_at
      from public.projects as pr
      join public.profiles as pm on pm.id = pr.project_manager_id
      left join public.profiles as cb on cb.id = pr.created_by
     where pr.id = p_project_id
       and (v_role = 'SUPER_ADMIN'::public.app_role or pr.project_manager_id = v_actor);
end;
$$;


create function private.list_project_manager_options()
returns table (id uuid, full_name text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role public.app_role;
begin
  select a.actor_role into v_role from private.project_actor() as a;
  if v_role <> 'SUPER_ADMIN'::public.app_role then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  return query
    select p.id, p.full_name, p.email
      from public.profiles as p
     where p.is_active
       and p.role = 'PROJECT_MANAGER'::public.app_role
     order by pg_catalog.lower(coalesce(p.full_name, p.email)) asc nulls last, p.id asc
     limit 500;
end;
$$;


create function private.create_project(
  p_name text,
  p_project_key text,
  p_description text,
  p_priority public.project_priority,
  p_start_date date,
  p_target_date date,
  p_project_manager_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_fields record;
  v_key text := pg_catalog.upper(private.trim_text(p_project_key));
  v_pm uuid;
  v_id uuid;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from private.project_actor() as a;

  if v_role = 'SUPER_ADMIN'::public.app_role then
    v_pm := p_project_manager_id;
  elsif v_role = 'PROJECT_MANAGER'::public.app_role then
    -- PMs always own what they create; they may not name someone else.
    if p_project_manager_id is not null and p_project_manager_id <> v_actor then
      raise exception using errcode = '42501', message = 'forbidden';
    end if;
    v_pm := v_actor;
  else
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select * into v_fields
    from private.validate_project_fields(p_name, p_description, p_priority, p_start_date, p_target_date);

  if v_key is null or v_key !~ '^[A-Z][A-Z0-9]{1,9}$' then
    raise exception using errcode = '22023', message = 'invalid_project_key';
  end if;

  if v_pm is null or not private.is_active_project_manager(v_pm) then
    raise exception using errcode = '22023', message = 'invalid_project_manager';
  end if;

  if exists (select 1 from public.projects as pr where pr.project_key = v_key) then
    raise exception using errcode = '23505', message = 'duplicate_project_key';
  end if;

  begin
    insert into public.projects (name, project_key, description, priority, project_manager_id,
                                 start_date, target_date, created_by)
    values (v_fields.v_name, v_key, v_fields.v_description, p_priority, v_pm,
            p_start_date, p_target_date, v_actor)
    returning projects.id into v_id;
  exception when unique_violation then
    -- Concurrent creation with the same key.
    raise exception using errcode = '23505', message = 'duplicate_project_key';
  end;

  insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
  values (v_actor, v_id, 'PROJECT_CREATED', '{}'::jsonb, pg_catalog.jsonb_build_object(
    'name', v_fields.v_name, 'project_key', v_key, 'description', v_fields.v_description,
    'status', 'planning', 'priority', p_priority, 'project_manager_id', v_pm,
    'start_date', p_start_date, 'target_date', p_target_date));

  return v_id;
end;
$$;


create function private.update_project(
  p_project_id uuid,
  p_name text,
  p_description text,
  p_status public.project_status,
  p_priority public.project_priority,
  p_start_date date,
  p_target_date date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_fields record;
  v_old jsonb;
  v_new jsonb;
  v_diff record;
  v_archived timestamptz;
begin
  select l.actor_id, l.actor_role into v_actor, v_role from private.lock_managed_project(p_project_id) as l;

  if p_status is null then
    raise exception using errcode = '22023', message = 'invalid_status';
  end if;
  select * into v_fields
    from private.validate_project_fields(p_name, p_description, p_priority, p_start_date, p_target_date);

  select pr.archived_at,
         pg_catalog.jsonb_build_object(
           'name', pr.name, 'description', pr.description, 'status', pr.status,
           'priority', pr.priority, 'start_date', pr.start_date, 'target_date', pr.target_date)
    into v_archived, v_old
    from public.projects as pr
   where pr.id = p_project_id;

  if v_archived is not null then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;

  v_new := pg_catalog.jsonb_build_object(
    'name', v_fields.v_name, 'description', v_fields.v_description, 'status', p_status,
    'priority', p_priority, 'start_date', p_start_date, 'target_date', p_target_date);

  select * into v_diff from private.jsonb_changed(v_old, v_new);
  if v_diff.new_values <> '{}'::jsonb then
    update public.projects as pr
       set name = v_fields.v_name,
           description = v_fields.v_description,
           status = p_status,
           priority = p_priority,
           start_date = p_start_date,
           target_date = p_target_date
     where pr.id = p_project_id;

    insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
    values (v_actor, p_project_id, 'PROJECT_UPDATED', v_diff.old_values, v_diff.new_values);
  end if;

  return p_project_id;
end;
$$;


create function private.assign_project_manager(p_project_id uuid, p_project_manager_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_old_pm uuid;
  v_archived timestamptz;
begin
  -- Early rejection: only Super Admins assign or reassign PMs.
  select a.actor_role into v_role from private.project_actor() as a;
  if v_role <> 'SUPER_ADMIN'::public.app_role then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select l.actor_id, l.actor_role into v_actor, v_role from private.lock_managed_project(p_project_id) as l;
  if v_role <> 'SUPER_ADMIN'::public.app_role then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select pr.project_manager_id, pr.archived_at into v_old_pm, v_archived
    from public.projects as pr where pr.id = p_project_id;

  if v_archived is not null then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;

  if p_project_manager_id is null or not private.is_active_project_manager(p_project_manager_id) then
    raise exception using errcode = '22023', message = 'invalid_project_manager';
  end if;

  if v_old_pm <> p_project_manager_id then
    update public.projects as pr set project_manager_id = p_project_manager_id where pr.id = p_project_id;
    insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
    values (v_actor, p_project_id, 'PROJECT_MANAGER_CHANGED',
            pg_catalog.jsonb_build_object('project_manager_id', v_old_pm),
            pg_catalog.jsonb_build_object('project_manager_id', p_project_manager_id));
  end if;

  return p_project_id;
end;
$$;


create function private.set_project_archived(p_project_id uuid, p_archived boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_old timestamptz;
  v_new timestamptz;
begin
  if p_archived is null then
    raise exception using errcode = '22023', message = 'invalid_archived';
  end if;

  select l.actor_id, l.actor_role into v_actor, v_role from private.lock_managed_project(p_project_id) as l;

  select pr.archived_at into v_old from public.projects as pr where pr.id = p_project_id;

  -- Idempotent: archiving an archived project (or restoring an active one) is a no-op.
  if (v_old is not null) = p_archived then
    return p_project_id;
  end if;

  v_new := case when p_archived then pg_catalog.now() else null end;
  update public.projects as pr set archived_at = v_new where pr.id = p_project_id;

  insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
  values (v_actor, p_project_id,
          case when p_archived then 'PROJECT_ARCHIVED' else 'PROJECT_RESTORED' end,
          pg_catalog.jsonb_build_object('archived_at', v_old),
          pg_catalog.jsonb_build_object('archived_at', v_new));

  return p_project_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Ownership transfer and EXECUTE privileges (same pattern as Phase 2/4)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

alter function private.project_actor() owner to cyclo_project_api;
alter function private.trim_text(text) owner to cyclo_project_api;
alter function private.is_active_project_manager(uuid) owner to cyclo_project_api;
alter function private.validate_project_fields(text, text, public.project_priority, date, date) owner to cyclo_project_api;
alter function private.lock_managed_project(uuid) owner to cyclo_project_api;
alter function private.jsonb_changed(jsonb, jsonb) owner to cyclo_project_api;
alter function private.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) owner to cyclo_project_api;
alter function private.get_project(uuid) owner to cyclo_project_api;
alter function private.list_project_manager_options() owner to cyclo_project_api;
alter function private.create_project(text, text, text, public.project_priority, date, date, uuid) owner to cyclo_project_api;
alter function private.update_project(uuid, text, text, public.project_status, public.project_priority, date, date) owner to cyclo_project_api;
alter function private.assign_project_manager(uuid, uuid) owner to cyclo_project_api;
alter function private.set_project_archived(uuid, boolean) owner to cyclo_project_api;

set role cyclo_project_api;

revoke all on function private.project_actor() from public, anon, authenticated, service_role;
revoke all on function private.trim_text(text) from public, anon, authenticated, service_role;
revoke all on function private.is_active_project_manager(uuid) from public, anon, authenticated, service_role;
revoke all on function private.validate_project_fields(text, text, public.project_priority, date, date) from public, anon, authenticated, service_role;
revoke all on function private.lock_managed_project(uuid) from public, anon, authenticated, service_role;
revoke all on function private.jsonb_changed(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.get_project(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_project_manager_options() from public, anon, authenticated, service_role;
revoke all on function private.create_project(text, text, text, public.project_priority, date, date, uuid) from public, anon, authenticated, service_role;
revoke all on function private.update_project(uuid, text, text, public.project_status, public.project_priority, date, date) from public, anon, authenticated, service_role;
revoke all on function private.assign_project_manager(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_project_archived(uuid, boolean) from public, anon, authenticated, service_role;

-- Reachable only through the public wrappers (private is not exposed by the Data API).
grant execute on function private.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) to authenticated;
grant execute on function private.get_project(uuid) to authenticated;
grant execute on function private.list_project_manager_options() to authenticated;
grant execute on function private.create_project(text, text, text, public.project_priority, date, date, uuid) to authenticated;
grant execute on function private.update_project(uuid, text, text, public.project_status, public.project_priority, date, date) to authenticated;
grant execute on function private.assign_project_manager(uuid, uuid) to authenticated;
grant execute on function private.set_project_archived(uuid, boolean) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 9. Public RPC wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_projects(
  p_search text default null,
  p_status public.project_status default null,
  p_priority public.project_priority default null,
  p_archived boolean default false,
  p_sort text default 'updated_desc',
  p_page integer default 1,
  p_page_size integer default 12
)
returns table (
  id uuid, name text, project_key text, description text,
  status public.project_status, priority public.project_priority,
  project_manager_id uuid, project_manager_name text,
  start_date date, target_date date,
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz,
  total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  select l.id, l.name, l.project_key, l.description, l.status, l.priority,
         l.project_manager_id, l.project_manager_name, l.start_date, l.target_date,
         l.created_at, l.updated_at, l.archived_at, l.total_count
    from private.list_projects(p_search, p_status, p_priority, p_archived, p_sort, p_page, p_page_size) as l
$$;

create function public.get_project(p_project_id uuid)
returns table (
  id uuid, name text, project_key text, description text,
  status public.project_status, priority public.project_priority,
  project_manager_id uuid, project_manager_name text, project_manager_email text,
  project_manager_is_active boolean,
  start_date date, target_date date,
  created_by uuid, created_by_name text,
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select g.id, g.name, g.project_key, g.description, g.status, g.priority,
         g.project_manager_id, g.project_manager_name, g.project_manager_email,
         g.project_manager_is_active, g.start_date, g.target_date,
         g.created_by, g.created_by_name, g.created_at, g.updated_at, g.archived_at
    from private.get_project(p_project_id) as g
$$;

create function public.list_project_manager_options()
returns table (id uuid, full_name text, email text)
language sql stable security invoker set search_path = ''
as $$
  select o.id, o.full_name, o.email from private.list_project_manager_options() as o
$$;

create function public.create_project(
  p_name text,
  p_project_key text,
  p_priority public.project_priority,
  p_description text default null,
  p_start_date date default null,
  p_target_date date default null,
  p_project_manager_id uuid default null
)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.create_project(p_name, p_project_key, p_description, p_priority,
                                p_start_date, p_target_date, p_project_manager_id)
$$;

create function public.update_project(
  p_project_id uuid,
  p_name text,
  p_status public.project_status,
  p_priority public.project_priority,
  p_description text default null,
  p_start_date date default null,
  p_target_date date default null
)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.update_project(p_project_id, p_name, p_description, p_status, p_priority,
                                p_start_date, p_target_date)
$$;

create function public.assign_project_manager(p_project_id uuid, p_project_manager_id uuid)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.assign_project_manager(p_project_id, p_project_manager_id)
$$;

create function public.archive_project(p_project_id uuid)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.set_project_archived(p_project_id, true)
$$;

create function public.restore_project(p_project_id uuid)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.set_project_archived(p_project_id, false)
$$;

revoke all on function public.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_project(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_project_manager_options() from public, anon, authenticated, service_role;
revoke all on function public.create_project(text, text, public.project_priority, text, date, date, uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_project(uuid, text, public.project_status, public.project_priority, text, date, date) from public, anon, authenticated, service_role;
revoke all on function public.assign_project_manager(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.archive_project(uuid) from public, anon, authenticated, service_role;
revoke all on function public.restore_project(uuid) from public, anon, authenticated, service_role;

grant execute on function public.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) to authenticated;
grant execute on function public.get_project(uuid) to authenticated;
grant execute on function public.list_project_manager_options() to authenticated;
grant execute on function public.create_project(text, text, public.project_priority, text, date, date, uuid) to authenticated;
grant execute on function public.update_project(uuid, text, public.project_status, public.project_priority, text, date, date) to authenticated;
grant execute on function public.assign_project_manager(uuid, uuid) to authenticated;
grant execute on function public.archive_project(uuid) to authenticated;
grant execute on function public.restore_project(uuid) to authenticated;

comment on function public.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) is
  'Project page. SA: all; PM: assigned; DEVELOPER: none until membership exists.';
comment on function public.get_project(uuid) is
  'Project detail with the same visibility as list_projects; zero rows when not visible.';
comment on function public.list_project_manager_options() is
  'Active Project Managers for assignment. Active SUPER_ADMIN only.';
comment on function public.create_project(text, text, public.project_priority, text, date, date, uuid) is
  'Create a project. SA must choose an active PM; a PM always becomes the PM.';
comment on function public.update_project(uuid, text, public.project_status, public.project_priority, text, date, date) is
  'Update editable fields. SA or the assigned PM; archived projects must be restored first.';
comment on function public.assign_project_manager(uuid, uuid) is
  'Assign or reassign the PM. Active SUPER_ADMIN only.';
comment on function public.archive_project(uuid) is 'Archive a project (SA or assigned PM). Idempotent.';
comment on function public.restore_project(uuid) is 'Restore an archived project (SA or assigned PM). Idempotent.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres only if this migration must be undone.
-- Dropping public.projects deletes all project data.)
--
-- drop function if exists public.restore_project(uuid);
-- drop function if exists public.archive_project(uuid);
-- drop function if exists public.assign_project_manager(uuid, uuid);
-- drop function if exists public.update_project(uuid, text, public.project_status, public.project_priority, text, date, date);
-- drop function if exists public.create_project(text, text, public.project_priority, text, date, date, uuid);
-- drop function if exists public.list_project_manager_options();
-- drop function if exists public.get_project(uuid);
-- drop function if exists public.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer);
-- grant cyclo_project_api to postgres with inherit false, set true;
-- drop function if exists private.set_project_archived(uuid, boolean);
-- drop function if exists private.assign_project_manager(uuid, uuid);
-- drop function if exists private.update_project(uuid, text, text, public.project_status, public.project_priority, date, date);
-- drop function if exists private.create_project(text, text, text, public.project_priority, date, date, uuid);
-- drop function if exists private.list_project_manager_options();
-- drop function if exists private.get_project(uuid);
-- drop function if exists private.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer);
-- drop function if exists private.jsonb_changed(jsonb, jsonb);
-- drop function if exists private.lock_managed_project(uuid);
-- drop function if exists private.validate_project_fields(text, text, public.project_priority, date, date);
-- drop function if exists private.is_active_project_manager(uuid);
-- drop function if exists private.trim_text(text);
-- drop function if exists private.project_actor();
-- revoke cyclo_project_api from postgres;
-- drop table if exists private.project_audit_log;
-- drop table if exists public.projects;   -- triggers and policies go with it
-- drop function if exists private.prevent_project_delete();
-- drop function if exists private.guard_project_row();
-- drop policy if exists "Project API role reads profiles for authorized RPCs" on public.profiles;
-- revoke all on table public.profiles from cyclo_project_api;
-- revoke execute on function private.request_user_id() from cyclo_project_api;
-- revoke all on schema private from cyclo_project_api;
-- drop role if exists cyclo_project_api;
-- drop type if exists public.project_priority;
-- drop type if exists public.project_status;
-- =============================================================================
