-- =============================================================================
-- CYCLO Phase 8B: project team membership (local deployment only)
--
-- Creates:
--   * table    public.project_members           (RLS, writes only through RPCs)
--   * trigger  project_members_guard_row         (member = active DEVELOPER, not the PM)
--   * helpers  private.is_project_member(uuid), private.is_assigned_project_manager(uuid)
--              (postgres-owned SECURITY DEFINER; used by RLS without policy recursion)
--   * RPCs     (public SECURITY INVOKER wrappers over private SECURITY DEFINER code
--              owned by cyclo_project_api, as in Phase 8A):
--       list_project_members(uuid)                       SA · assigned PM · member developers
--       list_assignable_developers(uuid, text, integer)  SA · assigned PM
--       add_project_member(uuid, uuid)                   SA · assigned PM
--       remove_project_member(uuid, uuid)                SA · assigned PM
--   * audit actions PROJECT_MEMBER_ADDED / PROJECT_MEMBER_REMOVED
--
-- Changes (same signatures and result columns):
--   * private.list_projects / private.get_project: developers now see the
--     projects they are members of (previously none).
--   * public.projects RLS: developers may read rows of projects they belong to.
--
-- Rules
--   * Unique (project_id, profile_id): no duplicate memberships.
--   * Only ACTIVE profiles with role DEVELOPER can be added; the assigned PM is
--     never a developer member (trigger, so it holds for every writer).
--   * Developers cannot add or remove anyone, including themselves: there are
--     no direct write privileges, and every write RPC requires SA or the
--     assigned PM (private.lock_managed_project from Phase 8A).
--   * Archived projects are read-only: membership cannot change.
--   * Memberships are removed (hard delete, audited); projects still are not.
--
-- Unchanged: employee/profile tables, grants and RPCs; Phase 8A Super Admin and
-- PM visibility and all Phase 8A write rules.
--
-- Error contract additions
--   22023 'invalid_member'      not an active DEVELOPER, or the assigned PM
--   23505 'duplicate_member'
--   P0002 'member_not_found'
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
create table public.project_members (
  id          uuid        primary key default gen_random_uuid(),
  -- Projects are never deleted (Phase 8A trigger); CASCADE only matters for
  -- owner-level maintenance.
  project_id  uuid        not null references public.projects (id) on delete cascade,
  profile_id  uuid        not null references public.profiles (id) on delete cascade,
  added_by    uuid        not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),

  constraint project_members_project_profile_key unique (project_id, profile_id)
);

comment on table public.project_members is
  'Developer membership of projects. Writes only through project RPCs (SA or assigned PM).';

-- (project_id, profile_id) is covered by the unique index; these cover the
-- developer-visibility lookups and the added_by foreign key.
create index project_members_profile_id_idx on public.project_members (profile_id);
create index project_members_added_by_idx   on public.project_members (added_by);


-- -----------------------------------------------------------------------------
-- 2. Row guard (owner: postgres, so it can read profiles/projects for every writer)
-- -----------------------------------------------------------------------------
create function private.guard_project_member_row()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
begin
  if TG_OP = 'UPDATE' then
    raise exception using errcode = '22023', message = 'project_member_immutable';
  end if;

  if not exists (
    select 1 from public.profiles as p
     where p.id = new.profile_id
       and p.is_active
       and p.role = 'DEVELOPER'::public.app_role
  ) or exists (
    select 1 from public.projects as pr
     where pr.id = new.project_id
       and pr.project_manager_id = new.profile_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'invalid_member',
      constraint = 'project_members_member_valid',
      schema = 'public',
      table = 'project_members';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_project_member_row() from public, anon, authenticated, service_role;

create trigger project_members_guard_row
  before insert or update on public.project_members
  for each row
  execute function private.guard_project_member_row();

alter table public.project_members enable always trigger project_members_guard_row;


-- -----------------------------------------------------------------------------
-- 3. RLS helpers (postgres-owned, row_security off: no policy recursion between
--    projects and project_members). Return only booleans about the caller.
-- -----------------------------------------------------------------------------
create function private.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1 from public.project_members as m
     where m.project_id = p_project_id
       and m.profile_id = (select auth.uid())
  )
$$;

create function private.is_assigned_project_manager(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1 from public.projects as pr
     where pr.id = p_project_id
       and pr.project_manager_id = (select auth.uid())
  )
$$;

revoke all on function private.is_project_member(uuid) from public, anon, authenticated, service_role;
revoke all on function private.is_assigned_project_manager(uuid) from public, anon, authenticated, service_role;
grant execute on function private.is_project_member(uuid) to authenticated;
grant execute on function private.is_assigned_project_manager(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 4. Privileges and RLS
-- -----------------------------------------------------------------------------
alter table public.project_members enable row level security;

revoke all on table public.project_members from public, anon, authenticated, service_role, cyclo_project_api;

-- Employees: read-only, row-filtered. No INSERT/UPDATE/DELETE for anyone via the API.
grant select on table public.project_members to authenticated;
grant select on table public.project_members to service_role;

create policy "Super admins read all project members"
  on public.project_members for select to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');

create policy "Project managers read members of assigned projects"
  on public.project_members for select to authenticated
  using (
    (select private.current_app_role()) = 'PROJECT_MANAGER'
    and private.is_assigned_project_manager(project_id)
  );

create policy "Developers read members of their projects"
  on public.project_members for select to authenticated
  using (
    (select private.current_app_role()) = 'DEVELOPER'
    and private.is_project_member(project_id)
  );

create policy "Developers read projects they belong to"
  on public.projects for select to authenticated
  using (
    (select private.current_app_role()) = 'DEVELOPER'
    and private.is_project_member(id)
  );

-- RPC owner: read, insert and delete memberships; never update.
grant select on table public.project_members to cyclo_project_api;
grant insert (project_id, profile_id, added_by) on table public.project_members to cyclo_project_api;
grant delete on table public.project_members to cyclo_project_api;

create policy "Project API role reads members for authorized RPCs"
  on public.project_members for select to cyclo_project_api using (true);
create policy "Project API role adds members for authorized RPCs"
  on public.project_members for insert to cyclo_project_api with check (true);
create policy "Project API role removes members for authorized RPCs"
  on public.project_members for delete to cyclo_project_api using (true);


-- -----------------------------------------------------------------------------
-- 5. Audit actions
-- -----------------------------------------------------------------------------
alter table private.project_audit_log drop constraint project_audit_log_action_check;
alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
  'PROJECT_ARCHIVED', 'PROJECT_RESTORED',
  'PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED'));


-- -----------------------------------------------------------------------------
-- 6. Private implementations (owner cyclo_project_api; same transfer pattern)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Read access to one project's team: SA, the assigned PM, or a member developer.
-- Anything else is reported as not found (existence is not disclosed).
create function private.require_project_team_reader(p_project_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
begin
  select a.actor_id, a.actor_role into v_actor, v_role from private.project_actor() as a;

  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;

  if not exists (
    select 1 from public.projects as pr
     where pr.id = p_project_id
       and (
         v_role = 'SUPER_ADMIN'::public.app_role
         or (v_role = 'PROJECT_MANAGER'::public.app_role and pr.project_manager_id = v_actor)
         or (v_role = 'DEVELOPER'::public.app_role and exists (
               select 1 from public.project_members as m
                where m.project_id = pr.id and m.profile_id = v_actor))
       )
  ) then
    raise exception using errcode = 'P0002', message = 'project_not_found';
  end if;
end;
$$;

-- Phase 8A list_projects with membership-based developer visibility.
create or replace function private.list_projects(
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

  return query
    select pr.id, pr.name, pr.project_key, pr.description, pr.status, pr.priority,
           pr.project_manager_id,
           coalesce(pm.full_name, pm.email),
           pr.start_date, pr.target_date, pr.created_at, pr.updated_at, pr.archived_at,
           pg_catalog.count(*) over ()
      from public.projects as pr
      join public.profiles as pm on pm.id = pr.project_manager_id
     where (
             v_role = 'SUPER_ADMIN'::public.app_role
             or (v_role = 'PROJECT_MANAGER'::public.app_role and pr.project_manager_id = v_actor)
             or (v_role = 'DEVELOPER'::public.app_role and exists (
                   select 1 from public.project_members as m
                    where m.project_id = pr.id and m.profile_id = v_actor))
           )
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

-- Phase 8A get_project with membership-based developer visibility.
create or replace function private.get_project(p_project_id uuid)
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
       and (
             v_role = 'SUPER_ADMIN'::public.app_role
             or (v_role = 'PROJECT_MANAGER'::public.app_role and pr.project_manager_id = v_actor)
             or (v_role = 'DEVELOPER'::public.app_role and exists (
                   select 1 from public.project_members as m
                    where m.project_id = pr.id and m.profile_id = v_actor))
           );
end;
$$;

create function private.list_project_members(p_project_id uuid)
returns table (
  id uuid,
  profile_id uuid,
  full_name text,
  email text,
  role public.app_role,
  is_active boolean,
  added_by uuid,
  added_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_project_team_reader(p_project_id);

  return query
    select m.id, m.profile_id, p.full_name, p.email, p.role, p.is_active,
           m.added_by, coalesce(ab.full_name, ab.email), m.created_at
      from public.project_members as m
      join public.profiles as p on p.id = m.profile_id
      left join public.profiles as ab on ab.id = m.added_by
     where m.project_id = p_project_id
     order by pg_catalog.lower(coalesce(p.full_name, p.email)) asc nulls last, p.id asc;
end;
$$;

-- Candidates for the "Add developer" selector: active developers not yet on the team.
create function private.list_assignable_developers(p_project_id uuid, p_search text, p_limit integer)
returns table (id uuid, full_name text, email text)
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

  if v_role not in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if not exists (
    select 1 from public.projects as pr
     where pr.id = p_project_id
       and (v_role = 'SUPER_ADMIN'::public.app_role or pr.project_manager_id = v_actor)
  ) then
    raise exception using errcode = 'P0002', message = 'project_not_found';
  end if;

  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select p.id, p.full_name, p.email
      from public.profiles as p
     where p.is_active
       and p.role = 'DEVELOPER'::public.app_role
       and not exists (select 1 from public.project_members as m
                        where m.project_id = p_project_id and m.profile_id = p.id)
       and (v_pattern is null
            or p.full_name operator(pg_catalog.~~*) v_pattern
            or p.email     operator(pg_catalog.~~*) v_pattern)
     order by pg_catalog.lower(coalesce(p.full_name, p.email)) asc nulls last, p.id asc
     limit p_limit;
end;
$$;

create function private.add_project_member(p_project_id uuid, p_profile_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_pm uuid;
  v_archived timestamptz;
  v_id uuid;
begin
  -- SA or the assigned PM; locks the project row (serializes team changes).
  select l.actor_id, l.actor_role into v_actor, v_role from private.lock_managed_project(p_project_id) as l;

  select pr.project_manager_id, pr.archived_at into v_pm, v_archived
    from public.projects as pr where pr.id = p_project_id;

  if v_archived is not null then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;

  if p_profile_id is null
     or p_profile_id = v_pm
     or not exists (select 1 from public.profiles as p
                     where p.id = p_profile_id and p.is_active
                       and p.role = 'DEVELOPER'::public.app_role) then
    raise exception using errcode = '22023', message = 'invalid_member';
  end if;

  if exists (select 1 from public.project_members as m
              where m.project_id = p_project_id and m.profile_id = p_profile_id) then
    raise exception using errcode = '23505', message = 'duplicate_member';
  end if;

  insert into public.project_members (project_id, profile_id, added_by)
  values (p_project_id, p_profile_id, v_actor)
  returning project_members.id into v_id;

  insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
  values (v_actor, p_project_id, 'PROJECT_MEMBER_ADDED', '{}'::jsonb,
          pg_catalog.jsonb_build_object('profile_id', p_profile_id));

  return v_id;
end;
$$;

create function private.remove_project_member(p_project_id uuid, p_profile_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_archived timestamptz;
  v_id uuid;
begin
  select l.actor_id, l.actor_role into v_actor, v_role from private.lock_managed_project(p_project_id) as l;

  select pr.archived_at into v_archived from public.projects as pr where pr.id = p_project_id;
  if v_archived is not null then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;

  delete from public.project_members as m
   where m.project_id = p_project_id and m.profile_id = p_profile_id
  returning m.id into v_id;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'member_not_found';
  end if;

  insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values)
  values (v_actor, p_project_id, 'PROJECT_MEMBER_REMOVED',
          pg_catalog.jsonb_build_object('profile_id', p_profile_id), '{}'::jsonb);

  return v_id;
end;
$$;

revoke all on function private.require_project_team_reader(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_project_members(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_assignable_developers(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.add_project_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.remove_project_member(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function private.list_project_members(uuid) to authenticated;
grant execute on function private.list_assignable_developers(uuid, text, integer) to authenticated;
grant execute on function private.add_project_member(uuid, uuid) to authenticated;
grant execute on function private.remove_project_member(uuid, uuid) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 7. Public RPC wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_project_members(p_project_id uuid)
returns table (
  id uuid, profile_id uuid, full_name text, email text, role public.app_role,
  is_active boolean, added_by uuid, added_by_name text, created_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select m.id, m.profile_id, m.full_name, m.email, m.role, m.is_active, m.added_by, m.added_by_name, m.created_at
    from private.list_project_members(p_project_id) as m
$$;

create function public.list_assignable_developers(p_project_id uuid, p_search text default null, p_limit integer default 20)
returns table (id uuid, full_name text, email text)
language sql stable security invoker set search_path = ''
as $$
  select d.id, d.full_name, d.email from private.list_assignable_developers(p_project_id, p_search, p_limit) as d
$$;

create function public.add_project_member(p_project_id uuid, p_profile_id uuid)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.add_project_member(p_project_id, p_profile_id)
$$;

create function public.remove_project_member(p_project_id uuid, p_profile_id uuid)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.remove_project_member(p_project_id, p_profile_id)
$$;

revoke all on function public.list_project_members(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_assignable_developers(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.add_project_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.remove_project_member(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.list_project_members(uuid) to authenticated;
grant execute on function public.list_assignable_developers(uuid, text, integer) to authenticated;
grant execute on function public.add_project_member(uuid, uuid) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid) to authenticated;

comment on function public.list_project_members(uuid) is
  'Developer members of a project. SA, the assigned PM, or a member developer; P0002 otherwise.';
comment on function public.list_assignable_developers(uuid, text, integer) is
  'Active developers not yet on the project, for the add-member selector. SA or assigned PM.';
comment on function public.add_project_member(uuid, uuid) is
  'Add an active developer to a project. SA or assigned PM; not on archived projects.';
comment on function public.remove_project_member(uuid, uuid) is
  'Remove a developer from a project. SA or assigned PM; not on archived projects.';
comment on function public.list_projects(text, public.project_status, public.project_priority, boolean, text, integer, integer) is
  'Project page. SA: all; PM: assigned; DEVELOPER: projects they are members of.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres. Deletes all membership data.)
--
-- drop function if exists public.remove_project_member(uuid, uuid);
-- drop function if exists public.add_project_member(uuid, uuid);
-- drop function if exists public.list_assignable_developers(uuid, text, integer);
-- drop function if exists public.list_project_members(uuid);
-- grant cyclo_project_api to postgres with inherit false, set true;
-- drop function if exists private.remove_project_member(uuid, uuid);
-- drop function if exists private.add_project_member(uuid, uuid);
-- drop function if exists private.list_assignable_developers(uuid, text, integer);
-- drop function if exists private.list_project_members(uuid);
-- drop function if exists private.require_project_team_reader(uuid);
-- -- then re-run sections 7 (list_projects, get_project) of 20261125100000 to
-- -- restore the Phase 8A bodies, and: revoke cyclo_project_api from postgres;
-- drop policy if exists "Developers read projects they belong to" on public.projects;
-- drop table if exists public.project_members;
-- drop function if exists private.is_assigned_project_manager(uuid);
-- drop function if exists private.is_project_member(uuid);
-- drop function if exists private.guard_project_member_row();
-- delete from private.project_audit_log where action like 'PROJECT_MEMBER_%';
-- alter table private.project_audit_log drop constraint project_audit_log_action_check;
-- alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
--   'PROJECT_CREATED','PROJECT_UPDATED','PROJECT_MANAGER_CHANGED','PROJECT_ARCHIVED','PROJECT_RESTORED'));
-- =============================================================================
