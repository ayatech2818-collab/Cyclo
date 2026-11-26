-- =============================================================================
-- CYCLO Phase 8D: work item foundation (local deployment only)
--
-- Model
--   * One table, public.work_items, for EPIC / STORY / TASK / SUBTASK / BUG,
--     with a parent_id self-reference.
--   * Allowed parents (child -> parent):  EPIC -> none
--                                         STORY -> EPIC | none
--                                         TASK -> STORY | none
--                                         SUBTASK -> TASK (required)
--                                         BUG -> EPIC | STORY | TASK | none
--     Levels strictly decrease, so cycles are impossible by construction; the
--     guard trigger also walks ancestors explicitly (defence in depth and
--     future configurable hierarchies).
--   * Same-project parents are enforced by a composite foreign key
--     (project_id, parent_id) -> (project_id, id).
--   * Identifiers: <project_key>-<n>. n comes from private.work_item_counters,
--     incremented atomically (row lock) inside the insert trigger. Work items
--     are never deleted and counters never decrease, so keys are never reused.
--     project_key is immutable (Phase 8A), so issue_key is stable.
--   * Status workflow: private.work_item_transitions lists allowed moves (a
--     table, so per-project workflows can be added later without touching
--     work_items). BLOCKED remembers the status it came from
--     (blocked_from_status) and may only return there (or be cancelled).
--     The trigger rejects any other transition for every writer.
--
-- Permissions (RPCs; caller from auth.uid(), never from parameters)
--   read            SA · assigned PM · member developers   (Phase 8B reader check)
--   create          SA · assigned PM: any type
--                   member developer: TASK or BUG; assignee self or none
--   edit content    SA · assigned PM · the assigned developer
--   change status   SA · assigned PM · the assigned developer
--                   (manager-only moves: cancel, reopen)
--   assign / priority / type / parent / archive / restore:  SA · assigned PM
--   Assignees must be ACTIVE DEVELOPERS who are members of the project.
--   Archived projects and archived work items are read-only.
--
-- Audit: reuses private.project_audit_log (adds nullable work_item_id and
--   WORK_ITEM_* actions). list_project_activity gains an optional work-item
--   filter and work-item columns; its access rules are unchanged.
--
-- Unchanged: projects, project_members, employee/profile tables and all
-- existing RPC behaviour.
--
-- Error contract additions
--   P0002 'work_item_not_found'
--   22023 'invalid_type' | 'invalid_title' | 'invalid_description' | 'invalid_parent'
--         | 'invalid_assignee' | 'invalid_estimate' | 'invalid_date_range'
--         | 'invalid_status' | 'invalid_transition' | 'invalid_priority'
--   55000 'project_archived' | 'work_item_archived' | 'parent_archived'
--         | 'has_active_children'
--   42501 'forbidden'
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Enums (priority reuses public.project_priority)
-- -----------------------------------------------------------------------------
create type public.work_item_type as enum ('EPIC', 'STORY', 'TASK', 'SUBTASK', 'BUG');
create type public.work_item_status as enum ('BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELLED');


-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table private.work_item_counters (
  project_id  uuid    primary key references public.projects (id) on delete cascade,
  last_number integer not null check (last_number > 0)
);
comment on table private.work_item_counters is
  'Last issued work item number per project. Only incremented (insert trigger); never reused.';
alter table private.work_item_counters enable row level security;
revoke all on private.work_item_counters from public, anon, authenticated, service_role;

create table private.work_item_transitions (
  from_status  public.work_item_status not null,
  to_status    public.work_item_status not null,
  manager_only boolean not null default false,
  primary key (from_status, to_status),
  check (from_status <> to_status)
);
comment on table private.work_item_transitions is
  'Default workflow. manager_only moves require SA or the assigned PM. BLOCKED -> active is further limited to blocked_from_status.';
alter table private.work_item_transitions enable row level security;
revoke all on private.work_item_transitions from public, anon, authenticated, service_role;

insert into private.work_item_transitions (from_status, to_status, manager_only) values
  ('BACKLOG',     'TODO',        false),
  ('BACKLOG',     'CANCELLED',   true),
  ('TODO',        'BACKLOG',     false),
  ('TODO',        'IN_PROGRESS', false),
  ('TODO',        'BLOCKED',     false),
  ('TODO',        'CANCELLED',   true),
  ('IN_PROGRESS', 'TODO',        false),
  ('IN_PROGRESS', 'IN_REVIEW',   false),
  ('IN_PROGRESS', 'BLOCKED',     false),
  ('IN_PROGRESS', 'CANCELLED',   true),
  ('IN_REVIEW',   'IN_PROGRESS', false),
  ('IN_REVIEW',   'DONE',        false),
  ('IN_REVIEW',   'BLOCKED',     false),
  ('IN_REVIEW',   'CANCELLED',   true),
  ('BLOCKED',     'TODO',        false),
  ('BLOCKED',     'IN_PROGRESS', false),
  ('BLOCKED',     'IN_REVIEW',   false),
  ('BLOCKED',     'CANCELLED',   true),
  ('DONE',        'IN_PROGRESS', true),
  ('CANCELLED',   'BACKLOG',     true);

create table public.work_items (
  id                  uuid        primary key default gen_random_uuid(),
  project_id          uuid        not null references public.projects (id) on delete restrict,
  issue_number        integer     not null,
  issue_key           text        not null,
  type                public.work_item_type     not null,
  title               text        not null,
  description         text,
  parent_id           uuid,
  status              public.work_item_status   not null default 'BACKLOG',
  -- Set only while BLOCKED: the active status to return to.
  blocked_from_status public.work_item_status,
  priority            public.project_priority   not null default 'medium',
  assignee_id         uuid        references public.profiles (id) on delete restrict,
  reporter_id         uuid        not null references public.profiles (id) on delete restrict,
  start_date          date,
  due_date            date,
  -- Story points or hours, decided by future sprint planning.
  estimate            numeric(5, 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  archived_at         timestamptz,

  constraint work_items_project_number_key unique (project_id, issue_number),
  constraint work_items_issue_key_key unique (issue_key),
  -- Target of the same-project parent foreign key.
  constraint work_items_project_id_id_key unique (project_id, id),
  constraint work_items_parent_same_project_fkey foreign key (project_id, parent_id)
    references public.work_items (project_id, id) on delete restrict,
  constraint work_items_not_own_parent check (parent_id is null or parent_id <> id),
  constraint work_items_issue_number_positive check (issue_number > 0),
  constraint work_items_issue_key_format check (issue_key ~ '^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$'),
  constraint work_items_title_valid check (
    title = btrim(title) and char_length(title) between 1 and 255 and title !~ '[[:cntrl:]]'
  ),
  constraint work_items_description_valid check (
    description is null or char_length(btrim(description)) between 1 and 20000
  ),
  constraint work_items_dates_ordered check (start_date is null or due_date is null or start_date <= due_date),
  constraint work_items_estimate_range check (estimate is null or (estimate >= 0 and estimate <= 1000)),
  constraint work_items_blocked_state check (
    (status = 'BLOCKED') = (blocked_from_status is not null)
    and (blocked_from_status is null or blocked_from_status in ('TODO', 'IN_PROGRESS', 'IN_REVIEW'))
  ),
  constraint work_items_completed_state check ((status = 'DONE') = (completed_at is not null)),
  constraint work_items_subtask_has_parent check (type <> 'SUBTASK' or parent_id is not null),
  constraint work_items_epic_has_no_parent check (type <> 'EPIC' or parent_id is null)
);

comment on table public.work_items is
  'Epics, stories, tasks, subtasks and bugs. Writes only through work item RPCs; never deleted (archive instead).';
comment on column public.work_items.issue_key is 'Human-readable <project_key>-<issue_number>; generated by the database, immutable.';

create index work_items_project_updated_idx on public.work_items (project_id, (archived_at is null), updated_at desc);
create index work_items_project_status_idx  on public.work_items (project_id, status);
create index work_items_parent_id_idx       on public.work_items (parent_id);
create index work_items_assignee_id_idx     on public.work_items (assignee_id);
create index work_items_reporter_id_idx     on public.work_items (reporter_id);


-- -----------------------------------------------------------------------------
-- 3. Row guard (owner postgres; applies to every writer, including service_role)
-- -----------------------------------------------------------------------------
create function private.work_item_parent_allowed(p_child public.work_item_type, p_parent public.work_item_type)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  -- coalesce: comparisons with a NULL parent must yield false, never NULL.
  select coalesce(case p_child
    when 'EPIC'    then p_parent is null
    when 'STORY'   then p_parent is null or p_parent = 'EPIC'
    when 'TASK'    then p_parent is null or p_parent = 'STORY'
    when 'SUBTASK' then p_parent = 'TASK'
    when 'BUG'     then p_parent is null or p_parent in ('EPIC', 'STORY', 'TASK')
  end, false)
$$;
revoke all on function private.work_item_parent_allowed(public.work_item_type, public.work_item_type) from public, anon, authenticated, service_role;
grant execute on function private.work_item_parent_allowed(public.work_item_type, public.work_item_type) to cyclo_project_api;

create function private.guard_work_item_row()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_parent_type public.work_item_type;
  v_cursor uuid;
  v_depth integer := 0;
  v_number integer;
  v_key text;
begin
  if TG_OP = 'INSERT' then
    -- Identifier: atomic per-project counter (row lock serializes concurrent inserts).
    insert into private.work_item_counters as c (project_id, last_number)
    values (new.project_id, 1)
    on conflict (project_id) do update set last_number = c.last_number + 1
    returning c.last_number into v_number;

    select pr.project_key into v_key from public.projects as pr where pr.id = new.project_id;
    new.issue_number := v_number;
    new.issue_key := v_key || '-' || v_number;
    new.created_at := now();
    new.updated_at := now();
    new.completed_at := case when new.status = 'DONE' then now() end;
  else
    if new.project_id is distinct from old.project_id
       or new.issue_number is distinct from old.issue_number
       or new.issue_key is distinct from old.issue_key
       or new.reporter_id is distinct from old.reporter_id
       or new.created_at is distinct from old.created_at then
      raise exception using errcode = '22023', message = 'work_item_identity_immutable';
    end if;

    if new.status is distinct from old.status then
      if not exists (select 1 from private.work_item_transitions as t
                      where t.from_status = old.status and t.to_status = new.status)
         or (old.status = 'BLOCKED' and new.status <> 'CANCELLED' and new.status <> old.blocked_from_status) then
        raise exception using errcode = '22023', message = 'invalid_transition';
      end if;
      new.completed_at := case when new.status = 'DONE' then now() end;
    end if;
  end if;

  -- Assignee: an active developer who is a member of the project.
  if new.assignee_id is not null
     and (TG_OP = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (
       select 1 from public.project_members as m
         join public.profiles as p on p.id = m.profile_id
        where m.project_id = new.project_id
          and m.profile_id = new.assignee_id
          and p.is_active
          and p.role = 'DEVELOPER'::public.app_role
     ) then
    raise exception using errcode = '22023', message = 'invalid_assignee';
  end if;

  -- Hierarchy (insert, or type/parent changed).
  if TG_OP = 'INSERT' or new.type is distinct from old.type or new.parent_id is distinct from old.parent_id then
    if new.parent_id is not null then
      if new.parent_id = new.id then
        raise exception using errcode = '22023', message = 'invalid_parent';
      end if;
      select w.type into v_parent_type from public.work_items as w
       where w.id = new.parent_id and w.project_id = new.project_id;
      if not found then
        raise exception using errcode = '22023', message = 'invalid_parent';
      end if;
      -- Explicit cycle check: the new parent must not descend from this item.
      v_cursor := new.parent_id;
      while v_cursor is not null loop
        if v_cursor = new.id then
          raise exception using errcode = '22023', message = 'invalid_parent';
        end if;
        v_depth := v_depth + 1;
        if v_depth > 32 then
          raise exception using errcode = '22023', message = 'invalid_parent';
        end if;
        select w.parent_id into v_cursor from public.work_items as w where w.id = v_cursor;
      end loop;
    end if;

    if not private.work_item_parent_allowed(new.type, v_parent_type) then
      raise exception using errcode = '22023', message = 'invalid_parent';
    end if;

    -- A type change must keep every existing child valid.
    if TG_OP = 'UPDATE' and new.type is distinct from old.type and exists (
      select 1 from public.work_items as c
       where c.parent_id = new.id
         and not private.work_item_parent_allowed(c.type, new.type)
    ) then
      raise exception using errcode = '22023', message = 'invalid_type';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function private.guard_work_item_row() from public, anon, authenticated, service_role;

create trigger work_items_guard_row
  before insert or update on public.work_items
  for each row execute function private.guard_work_item_row();

-- Runs after the guard (alphabetical order) so updated_at is always "now".
create trigger work_items_set_updated_at
  before update on public.work_items
  for each row execute function private.set_updated_at();

create function private.prevent_work_item_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '23514',
    message = 'Work items cannot be deleted. Archive the work item instead.',
    constraint = 'work_items_no_delete';
end;
$$;
revoke all on function private.prevent_work_item_delete() from public, anon, authenticated, service_role;

create trigger work_items_prevent_delete
  before delete on public.work_items
  for each row execute function private.prevent_work_item_delete();
create trigger work_items_prevent_truncate
  before truncate on public.work_items
  for each statement execute function private.prevent_work_item_delete();

alter table public.work_items enable always trigger work_items_guard_row;
alter table public.work_items enable always trigger work_items_prevent_delete;
alter table public.work_items enable always trigger work_items_prevent_truncate;


-- -----------------------------------------------------------------------------
-- 4. Privileges and RLS
-- -----------------------------------------------------------------------------
alter table public.work_items enable row level security;
revoke all on table public.work_items from public, anon, authenticated, service_role, cyclo_project_api;

-- Employees: read-only, same visibility as the project itself.
grant select on table public.work_items to authenticated;
grant select on table public.work_items to service_role;

create policy "Super admins read all work items"
  on public.work_items for select to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');
create policy "Project managers read work items of assigned projects"
  on public.work_items for select to authenticated
  using ((select private.current_app_role()) = 'PROJECT_MANAGER' and private.is_assigned_project_manager(project_id));
create policy "Developers read work items of their projects"
  on public.work_items for select to authenticated
  using ((select private.current_app_role()) = 'DEVELOPER' and private.is_project_member(project_id));

-- RPC owner. issue_number, issue_key, completed_at and timestamps are set by triggers.
grant select on table public.work_items to cyclo_project_api;
grant insert (project_id, type, title, description, parent_id, status, priority,
              assignee_id, reporter_id, start_date, due_date, estimate)
  on table public.work_items to cyclo_project_api;
grant update (type, title, description, parent_id, status, blocked_from_status, priority,
              assignee_id, start_date, due_date, estimate, archived_at)
  on table public.work_items to cyclo_project_api;
create policy "Project API role reads work items" on public.work_items for select to cyclo_project_api using (true);
create policy "Project API role creates work items" on public.work_items for insert to cyclo_project_api with check (true);
create policy "Project API role updates work items" on public.work_items for update to cyclo_project_api using (true) with check (true);

grant select on private.work_item_transitions to cyclo_project_api;
create policy project_api_read_transitions on private.work_item_transitions for select to cyclo_project_api using (true);


-- -----------------------------------------------------------------------------
-- 5. Audit: reuse project_audit_log
-- -----------------------------------------------------------------------------
alter table private.project_audit_log add column work_item_id uuid;
comment on column private.project_audit_log.work_item_id is
  'Set for WORK_ITEM_* actions. No FK: audit history outlives any row.';
create index project_audit_log_work_item_created_idx
  on private.project_audit_log (work_item_id, created_at desc)
  where work_item_id is not null;

alter table private.project_audit_log drop constraint project_audit_log_action_check;
alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
  'PROJECT_ARCHIVED', 'PROJECT_RESTORED',
  'PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED',
  'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED', 'WORK_ITEM_PARENT_CHANGED',
  'WORK_ITEM_ASSIGNED', 'WORK_ITEM_PRIORITY_CHANGED', 'WORK_ITEM_STATUS_CHANGED',
  'WORK_ITEM_ARCHIVED', 'WORK_ITEM_RESTORED'));
alter table private.project_audit_log add constraint project_audit_log_work_item_scope check (
  (action like 'WORK_ITEM_%') = (work_item_id is not null));

grant insert (work_item_id) on private.project_audit_log to cyclo_project_api;


-- -----------------------------------------------------------------------------
-- 6. Implementations (owner cyclo_project_api; same transfer pattern)
-- -----------------------------------------------------------------------------
-- The Phase 8C wrapper (owner postgres) is replaced below with an extra parameter.
drop function public.list_project_activity(uuid, timestamptz, uuid, integer);

grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Caller's capabilities in one project. Raises P0002 when the project is not
-- visible to the caller (Phase 8B reader rules).
create function private.work_item_access(p_project_id uuid, out actor_id uuid, out actor_role public.app_role, out is_manager boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_project_team_reader(p_project_id);
  select a.actor_id, a.actor_role into actor_id, actor_role from private.project_actor() as a;
  is_manager := actor_role = 'SUPER_ADMIN'::public.app_role
    or (actor_role = 'PROJECT_MANAGER'::public.app_role and exists (
          select 1 from public.projects as pr where pr.id = p_project_id and pr.project_manager_id = actor_id));
end;
$$;

-- Locks a work item for a change and returns the caller's capabilities.
-- Archived projects are read-only; archived items only accept restore.
create function private.lock_work_item(
  p_work_item_id uuid,
  p_allow_archived boolean,
  out project_id uuid,
  out actor_id uuid,
  out actor_role public.app_role,
  out is_manager boolean,
  out is_assignee boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
begin
  if p_work_item_id is null then
    raise exception using errcode = '22023', message = 'invalid_work_item_id';
  end if;
  select w.project_id into project_id from public.work_items as w where w.id = p_work_item_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end if;
  begin
    select a.actor_id, a.actor_role, a.is_manager into actor_id, actor_role, is_manager
      from private.work_item_access(project_id) as a;
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end;

  select w.assignee_id, w.archived_at into v_item from public.work_items as w where w.id = p_work_item_id for update;
  is_assignee := v_item.assignee_id is not null and v_item.assignee_id = actor_id;

  if exists (select 1 from public.projects as pr where pr.id = project_id and pr.archived_at is not null) then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;
  if v_item.archived_at is not null and not p_allow_archived then
    raise exception using errcode = '55000', message = 'work_item_archived';
  end if;
end;
$$;

create function private.validate_work_item_content(
  p_title text, p_description text, p_start_date date, p_due_date date, p_estimate numeric,
  out v_title text, out v_description text
)
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  v_title := private.trim_text(p_title);
  if v_title is null or pg_catalog.char_length(v_title) not between 1 and 255 or v_title ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_title';
  end if;
  v_description := nullif(private.trim_text(p_description), '');
  if v_description is not null and pg_catalog.char_length(v_description) > 20000 then
    raise exception using errcode = '22023', message = 'invalid_description';
  end if;
  if p_start_date is not null and p_due_date is not null and p_start_date > p_due_date then
    raise exception using errcode = '22023', message = 'invalid_date_range';
  end if;
  if p_estimate is not null and (p_estimate < 0 or p_estimate > 1000 or p_estimate <> round(p_estimate, 1)) then
    raise exception using errcode = '22023', message = 'invalid_estimate';
  end if;
end;
$$;

-- Parent check with friendly errors (the trigger is the authority).
create function private.check_work_item_parent(p_project_id uuid, p_type public.work_item_type, p_parent_id uuid, p_self uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parent record;
begin
  if p_parent_id is null then
    if not private.work_item_parent_allowed(p_type, null) then
      raise exception using errcode = '22023', message = 'invalid_parent';
    end if;
    return;
  end if;
  select w.type, w.archived_at into v_parent
    from public.work_items as w where w.id = p_parent_id and w.project_id = p_project_id;
  if not found or p_parent_id = p_self or not private.work_item_parent_allowed(p_type, v_parent.type) then
    raise exception using errcode = '22023', message = 'invalid_parent';
  end if;
  if v_parent.archived_at is not null then
    raise exception using errcode = '55000', message = 'parent_archived';
  end if;
end;
$$;

create function private.audit_work_item(p_actor uuid, p_project_id uuid, p_work_item_id uuid, p_action text, p_old jsonb, p_new jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.project_audit_log (actor_id, project_id, work_item_id, action, old_values, new_values)
  values (p_actor, p_project_id, p_work_item_id, p_action, p_old, p_new)
$$;

create function private.list_work_items(
  p_project_id uuid,
  p_search text,
  p_type public.work_item_type,
  p_status public.work_item_status,
  p_priority public.project_priority,
  p_assignee_id uuid,
  p_unassigned boolean,
  p_archived boolean,
  p_sort text,
  p_page integer,
  p_page_size integer
)
returns table (
  id uuid, issue_key text, issue_number integer, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  parent_id uuid, parent_issue_key text,
  assignee_id uuid, assignee_name text,
  due_date date, estimate numeric, child_count integer,
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_search text := nullif(private.trim_text(p_search), '');
  v_pattern text;
  v_number integer;
  v_exact_key boolean := false;
begin
  perform private.work_item_access(p_project_id);

  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;
  if p_archived is null or p_unassigned is null then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_sort is null or p_sort not in ('updated_desc', 'created_desc', 'key_asc', 'key_desc', 'priority_desc', 'due_asc', 'status_asc', 'title_asc') then
    raise exception using errcode = '22023', message = 'invalid_sort';
  end if;
  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- "CPR-42" is an exact key lookup; "42" matches issue number 42 (or titles).
    if v_search ~ '^([A-Za-z][A-Za-z0-9]{1,9}-)?[0-9]{1,9}$' then
      v_number := pg_catalog.substring(v_search, '([0-9]+)$')::integer;
      v_exact_key := pg_catalog.strpos(v_search, '-') > 0;
    end if;
  end if;

  return query
    select w.id, w.issue_key, w.issue_number, w.type, w.title, w.status, w.priority,
           w.parent_id, parent.issue_key,
           w.assignee_id, coalesce(assignee.full_name, assignee.email),
           w.due_date, w.estimate,
           (select pg_catalog.count(*)::integer from public.work_items as c
             where c.parent_id = w.id and c.archived_at is null),
           w.created_at, w.updated_at, w.archived_at,
           pg_catalog.count(*) over ()
      from public.work_items as w
      left join public.work_items as parent on parent.id = w.parent_id
      left join public.profiles as assignee on assignee.id = w.assignee_id
     where w.project_id = p_project_id
       and (case when p_archived then w.archived_at is not null else w.archived_at is null end)
       and (p_type is null or w.type = p_type)
       and (p_status is null or w.status = p_status)
       and (p_priority is null or w.priority = p_priority)
       and (p_assignee_id is null or w.assignee_id = p_assignee_id)
       and (not p_unassigned or w.assignee_id is null)
       and (v_pattern is null
            or (v_exact_key and pg_catalog.upper(v_search) = w.issue_key)
            or (not v_exact_key and v_number is not null
                and (w.issue_number = v_number or w.title operator(pg_catalog.~~*) v_pattern))
            or (v_number is null
                and (w.title operator(pg_catalog.~~*) v_pattern or w.issue_key operator(pg_catalog.~~*) v_pattern)))
     order by
       case when p_sort = 'key_asc'       then w.issue_number end asc,
       case when p_sort = 'key_desc'      then w.issue_number end desc,
       case when p_sort = 'created_desc'  then w.created_at end desc,
       case when p_sort = 'priority_desc' then w.priority end desc,
       case when p_sort = 'due_asc'       then w.due_date end asc nulls last,
       case when p_sort = 'status_asc'    then w.status end asc,
       case when p_sort = 'title_asc'     then pg_catalog.lower(w.title) end asc,
       w.updated_at desc,
       w.issue_number desc
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;

create function private.get_work_item(p_work_item_id uuid)
returns table (
  id uuid, project_id uuid, issue_key text, issue_number integer, type public.work_item_type,
  title text, description text, status public.work_item_status, blocked_from_status public.work_item_status,
  priority public.project_priority,
  parent_id uuid, parent_issue_key text, parent_title text, parent_type public.work_item_type,
  assignee_id uuid, assignee_name text, assignee_email text, assignee_is_eligible boolean,
  reporter_id uuid, reporter_name text,
  start_date date, due_date date, estimate numeric,
  created_at timestamptz, updated_at timestamptz, completed_at timestamptz, archived_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_project uuid;
begin
  if p_work_item_id is null then
    raise exception using errcode = '22023', message = 'invalid_work_item_id';
  end if;
  select w.project_id into v_project from public.work_items as w where w.id = p_work_item_id;
  if not found then
    return;
  end if;
  begin
    perform private.work_item_access(v_project);
  exception when sqlstate 'P0002' then
    return; -- not visible: same as missing
  end;

  return query
    select w.id, w.project_id, w.issue_key, w.issue_number, w.type, w.title, w.description,
           w.status, w.blocked_from_status, w.priority,
           w.parent_id, parent.issue_key, parent.title, parent.type,
           w.assignee_id, coalesce(assignee.full_name, assignee.email), assignee.email,
           (w.assignee_id is not null and assignee.is_active and assignee.role = 'DEVELOPER'::public.app_role
              and exists (select 1 from public.project_members as m
                           where m.project_id = w.project_id and m.profile_id = w.assignee_id)),
           w.reporter_id, coalesce(reporter.full_name, reporter.email),
           w.start_date, w.due_date, w.estimate,
           w.created_at, w.updated_at, w.completed_at, w.archived_at
      from public.work_items as w
      left join public.work_items as parent on parent.id = w.parent_id
      left join public.profiles as assignee on assignee.id = w.assignee_id
      left join public.profiles as reporter on reporter.id = w.reporter_id
     where w.id = p_work_item_id;
end;
$$;

create function private.list_work_item_children(p_work_item_id uuid)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  assignee_name text, archived_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_project uuid;
begin
  select w.project_id into v_project from public.work_items as w where w.id = p_work_item_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end if;
  begin
    perform private.work_item_access(v_project);
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end;

  return query
    select c.id, c.issue_key, c.type, c.title, c.status, c.priority,
           coalesce(assignee.full_name, assignee.email), c.archived_at
      from public.work_items as c
      left join public.profiles as assignee on assignee.id = c.assignee_id
     where c.parent_id = p_work_item_id
     order by (c.archived_at is not null), c.issue_number
     limit 200;
end;
$$;

-- Parent candidates for a given child type (search by key or title).
create function private.list_work_item_parent_options(
  p_project_id uuid, p_child_type public.work_item_type, p_search text, p_exclude_id uuid, p_limit integer
)
returns table (id uuid, issue_key text, type public.work_item_type, title text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_search text := nullif(private.trim_text(p_search), '');
  v_pattern text;
begin
  perform private.work_item_access(p_project_id);
  if p_child_type is null then
    raise exception using errcode = '22023', message = 'invalid_type';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select w.id, w.issue_key, w.type, w.title
      from public.work_items as w
     where w.project_id = p_project_id
       and w.archived_at is null
       and private.work_item_parent_allowed(p_child_type, w.type)
       and (p_exclude_id is null or w.id <> p_exclude_id)
       and (v_pattern is null or w.title operator(pg_catalog.~~*) v_pattern or w.issue_key operator(pg_catalog.~~*) v_pattern)
     order by w.updated_at desc, w.issue_number desc
     limit p_limit;
end;
$$;

create function private.create_work_item(
  p_project_id uuid,
  p_type public.work_item_type,
  p_title text,
  p_description text,
  p_parent_id uuid,
  p_status public.work_item_status,
  p_priority public.project_priority,
  p_assignee_id uuid,
  p_start_date date,
  p_due_date date,
  p_estimate numeric
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
  v_manager boolean;
  v_content record;
  v_id uuid;
begin
  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;
  select a.actor_id, a.actor_role, a.is_manager into v_actor, v_role, v_manager from private.work_item_access(p_project_id) as a;

  if p_type is null then
    raise exception using errcode = '22023', message = 'invalid_type';
  end if;
  if not v_manager then
    -- Member developers: tasks and bugs only, assigned to themselves or nobody.
    if v_role <> 'DEVELOPER'::public.app_role or p_type not in ('TASK', 'BUG') then
      raise exception using errcode = '42501', message = 'forbidden';
    end if;
    if p_assignee_id is not null and p_assignee_id <> v_actor then
      raise exception using errcode = '42501', message = 'forbidden';
    end if;
  end if;

  -- Serializes with archive/restore of the project.
  perform 1 from public.projects as pr where pr.id = p_project_id for share;
  if exists (select 1 from public.projects as pr where pr.id = p_project_id and pr.archived_at is not null) then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;

  if p_status is null or p_status not in ('BACKLOG', 'TODO') then
    raise exception using errcode = '22023', message = 'invalid_status';
  end if;
  if p_priority is null then
    raise exception using errcode = '22023', message = 'invalid_priority';
  end if;
  select * into v_content from private.validate_work_item_content(p_title, p_description, p_start_date, p_due_date, p_estimate);
  if p_parent_id is not null then
    perform 1 from public.work_items as w where w.id = p_parent_id for share;
  end if;
  perform private.check_work_item_parent(p_project_id, p_type, p_parent_id, null);

  insert into public.work_items (project_id, type, title, description, parent_id, status, priority,
                                 assignee_id, reporter_id, start_date, due_date, estimate)
  values (p_project_id, p_type, v_content.v_title, v_content.v_description, p_parent_id, p_status, p_priority,
          p_assignee_id, v_actor, p_start_date, p_due_date, p_estimate)
  returning work_items.id into v_id;

  perform private.audit_work_item(v_actor, p_project_id, v_id, 'WORK_ITEM_CREATED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('type', p_type, 'title', v_content.v_title, 'description', v_content.v_description,
      'status', p_status, 'priority', p_priority, 'parent_id', p_parent_id, 'assignee_id', p_assignee_id,
      'start_date', p_start_date, 'due_date', p_due_date, 'estimate', p_estimate));
  return v_id;
end;
$$;

create function private.update_work_item(
  p_work_item_id uuid, p_title text, p_description text, p_start_date date, p_due_date date, p_estimate numeric
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_content record;
  v_old jsonb;
  v_new jsonb;
  v_diff record;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not (v_lock.is_manager or v_lock.is_assignee) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  select * into v_content from private.validate_work_item_content(p_title, p_description, p_start_date, p_due_date, p_estimate);

  select pg_catalog.jsonb_build_object('title', w.title, 'description', w.description, 'start_date', w.start_date,
           'due_date', w.due_date, 'estimate', w.estimate)
    into v_old from public.work_items as w where w.id = p_work_item_id;
  v_new := pg_catalog.jsonb_build_object('title', v_content.v_title, 'description', v_content.v_description,
           'start_date', p_start_date, 'due_date', p_due_date, 'estimate', p_estimate);

  select * into v_diff from private.jsonb_changed(v_old, v_new);
  if v_diff.new_values <> '{}'::jsonb then
    update public.work_items as w
       set title = v_content.v_title, description = v_content.v_description,
           start_date = p_start_date, due_date = p_due_date, estimate = p_estimate
     where w.id = p_work_item_id;
    perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_UPDATED',
                                    v_diff.old_values, v_diff.new_values);
  end if;
  return p_work_item_id;
end;
$$;

create function private.change_work_item_status(p_work_item_id uuid, p_status public.work_item_status)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old public.work_item_status;
  v_blocked_from public.work_item_status;
  v_manager_only boolean;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not (v_lock.is_manager or v_lock.is_assignee) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_status is null then
    raise exception using errcode = '22023', message = 'invalid_status';
  end if;

  select w.status, w.blocked_from_status into v_old, v_blocked_from from public.work_items as w where w.id = p_work_item_id;
  if v_old = p_status then
    return p_work_item_id;
  end if;

  select t.manager_only into v_manager_only from private.work_item_transitions as t
   where t.from_status = v_old and t.to_status = p_status;
  if not found
     or (v_old = 'BLOCKED' and p_status <> 'CANCELLED' and p_status <> v_blocked_from) then
    raise exception using errcode = '22023', message = 'invalid_transition';
  end if;
  if v_manager_only and not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  update public.work_items as w
     set status = p_status,
         blocked_from_status = case when p_status = 'BLOCKED' then v_old end
   where w.id = p_work_item_id;

  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_STATUS_CHANGED',
    pg_catalog.jsonb_build_object('status', v_old), pg_catalog.jsonb_build_object('status', p_status));
  return p_work_item_id;
end;
$$;

create function private.assign_work_item(p_work_item_id uuid, p_assignee_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old uuid;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  select w.assignee_id into v_old from public.work_items as w where w.id = p_work_item_id;
  if v_old is not distinct from p_assignee_id then
    return p_work_item_id;
  end if;
  if p_assignee_id is not null and not exists (
    select 1 from public.project_members as m join public.profiles as p on p.id = m.profile_id
     where m.project_id = v_lock.project_id and m.profile_id = p_assignee_id
       and p.is_active and p.role = 'DEVELOPER'::public.app_role
  ) then
    raise exception using errcode = '22023', message = 'invalid_assignee';
  end if;

  update public.work_items as w set assignee_id = p_assignee_id where w.id = p_work_item_id;
  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_ASSIGNED',
    pg_catalog.jsonb_build_object('assignee_id', v_old), pg_catalog.jsonb_build_object('assignee_id', p_assignee_id));
  return p_work_item_id;
end;
$$;

create function private.change_work_item_priority(p_work_item_id uuid, p_priority public.project_priority)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old public.project_priority;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_priority is null then
    raise exception using errcode = '22023', message = 'invalid_priority';
  end if;
  select w.priority into v_old from public.work_items as w where w.id = p_work_item_id;
  if v_old = p_priority then
    return p_work_item_id;
  end if;
  update public.work_items as w set priority = p_priority where w.id = p_work_item_id;
  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_PRIORITY_CHANGED',
    pg_catalog.jsonb_build_object('priority', v_old), pg_catalog.jsonb_build_object('priority', p_priority));
  return p_work_item_id;
end;
$$;

-- Type and/or parent in one atomic change (a type change usually needs a new parent).
create function private.set_work_item_hierarchy(p_work_item_id uuid, p_type public.work_item_type, p_parent_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old_type public.work_item_type;
  v_old_parent uuid;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_type is null then
    raise exception using errcode = '22023', message = 'invalid_type';
  end if;

  select w.type, w.parent_id into v_old_type, v_old_parent from public.work_items as w where w.id = p_work_item_id;
  if v_old_type = p_type and v_old_parent is not distinct from p_parent_id then
    return p_work_item_id;
  end if;

  if p_parent_id is not null then
    perform 1 from public.work_items as w where w.id = p_parent_id for share;
  end if;
  perform private.check_work_item_parent(v_lock.project_id, p_type, p_parent_id, p_work_item_id);
  if v_old_type <> p_type and exists (
    select 1 from public.work_items as c
     where c.parent_id = p_work_item_id and not private.work_item_parent_allowed(c.type, p_type)
  ) then
    raise exception using errcode = '22023', message = 'invalid_type';
  end if;

  -- The trigger re-validates hierarchy and cycles.
  update public.work_items as w set type = p_type, parent_id = p_parent_id where w.id = p_work_item_id;

  if v_old_type <> p_type then
    perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_TYPE_CHANGED',
      pg_catalog.jsonb_build_object('type', v_old_type), pg_catalog.jsonb_build_object('type', p_type));
  end if;
  if v_old_parent is distinct from p_parent_id then
    perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_PARENT_CHANGED',
      pg_catalog.jsonb_build_object('parent_id', v_old_parent), pg_catalog.jsonb_build_object('parent_id', p_parent_id));
  end if;
  return p_work_item_id;
end;
$$;

create function private.set_work_item_archived(p_work_item_id uuid, p_archived boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old timestamptz;
  v_parent uuid;
begin
  if p_archived is null then
    raise exception using errcode = '22023', message = 'invalid_archived';
  end if;
  select * into v_lock from private.lock_work_item(p_work_item_id, true);
  if not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select w.archived_at, w.parent_id into v_old, v_parent from public.work_items as w where w.id = p_work_item_id;
  if (v_old is not null) = p_archived then
    return p_work_item_id;
  end if;
  if p_archived and exists (select 1 from public.work_items as c where c.parent_id = p_work_item_id and c.archived_at is null) then
    raise exception using errcode = '55000', message = 'has_active_children';
  end if;
  if not p_archived and v_parent is not null
     and exists (select 1 from public.work_items as p where p.id = v_parent and p.archived_at is not null) then
    raise exception using errcode = '55000', message = 'parent_archived';
  end if;

  update public.work_items as w set archived_at = case when p_archived then pg_catalog.now() end where w.id = p_work_item_id;
  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id,
    case when p_archived then 'WORK_ITEM_ARCHIVED' else 'WORK_ITEM_RESTORED' end, '{}'::jsonb, '{}'::jsonb);
  return p_work_item_id;
end;
$$;

-- Activity (Phase 8C) extended with work item events and an optional work item filter.
create or replace function private.project_activity_changes(p_action text, p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(c.item order by c.ord), '[]'::jsonb)
    from (
      select f.ord,
             case
               when f.field = 'description' then pg_catalog.jsonb_build_object('field', 'description')
               else pg_catalog.jsonb_build_object('field', f.field,
                      'from', pg_catalog.to_jsonb(p_old ->> f.field), 'to', pg_catalog.to_jsonb(p_new ->> f.field))
             end as item
        from (values (1, 'name', 'P'), (2, 'project_key', 'P'), (3, 'title', 'W'), (4, 'type', 'W'),
                     (5, 'status', 'B'), (6, 'priority', 'B'), (7, 'start_date', 'B'), (8, 'target_date', 'P'),
                     (9, 'due_date', 'W'), (10, 'estimate', 'W'), (11, 'description', 'B')) as f(ord, field, scope)
       where (p_action in ('PROJECT_CREATED', 'PROJECT_UPDATED') and f.scope in ('P', 'B')
              or p_action in ('WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED',
                              'WORK_ITEM_STATUS_CHANGED', 'WORK_ITEM_PRIORITY_CHANGED') and f.scope in ('W', 'B'))
         and (p_old ? f.field or p_new ? f.field)
         -- Creation shows only fields that were set.
         and not (p_action in ('PROJECT_CREATED', 'WORK_ITEM_CREATED') and (p_new ->> f.field) is null)
    ) as c
$$;

drop function private.list_project_activity(uuid, timestamptz, uuid, integer);

create function private.list_project_activity(
  p_project_id uuid,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_work_item_id uuid
)
returns table (
  id uuid,
  action text,
  created_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_avatar_kind text,
  actor_avatar_symbol text,
  subject_name text,
  previous_subject_name text,
  changes jsonb,
  work_item_id uuid,
  work_item_key text,
  work_item_title text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_project_team_reader(p_project_id);

  if p_limit is null or p_limit < 1 or p_limit > 101 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  return query
    select l.id,
           l.action,
           l.created_at,
           l.actor_id,
           coalesce(actor.full_name, actor.email),
           actor.avatar_kind,
           actor.avatar_symbol,
           case
             when l.action in ('PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED', 'PROJECT_MANAGER_CHANGED', 'WORK_ITEM_ASSIGNED')
               then coalesce(person.full_name, person.email)
             when l.action = 'WORK_ITEM_PARENT_CHANGED' then new_parent.issue_key
           end,
           case
             when l.action in ('PROJECT_MANAGER_CHANGED', 'WORK_ITEM_ASSIGNED')
               then coalesce(old_person.full_name, old_person.email)
             when l.action = 'WORK_ITEM_PARENT_CHANGED' then old_parent.issue_key
           end,
           private.project_activity_changes(l.action, l.old_values, l.new_values),
           l.work_item_id,
           item.issue_key,
           item.title
      from private.project_audit_log as l
      left join public.profiles as actor on actor.id = l.actor_id
      left join public.profiles as person on person.id = (case l.action
             when 'PROJECT_MEMBER_ADDED'    then l.new_values ->> 'profile_id'
             when 'PROJECT_MEMBER_REMOVED'  then l.old_values ->> 'profile_id'
             when 'PROJECT_MANAGER_CHANGED' then l.new_values ->> 'project_manager_id'
             when 'WORK_ITEM_ASSIGNED'      then l.new_values ->> 'assignee_id'
           end)::uuid
      left join public.profiles as old_person on old_person.id = (case l.action
             when 'PROJECT_MANAGER_CHANGED' then l.old_values ->> 'project_manager_id'
             when 'WORK_ITEM_ASSIGNED'      then l.old_values ->> 'assignee_id'
           end)::uuid
      left join public.work_items as item on item.id = l.work_item_id
      left join public.work_items as new_parent on l.action = 'WORK_ITEM_PARENT_CHANGED'
                                               and new_parent.id = (l.new_values ->> 'parent_id')::uuid
      left join public.work_items as old_parent on l.action = 'WORK_ITEM_PARENT_CHANGED'
                                               and old_parent.id = (l.old_values ->> 'parent_id')::uuid
     where l.project_id = p_project_id
       and (p_work_item_id is null or l.work_item_id = p_work_item_id)
       and (p_before_created_at is null
            or (l.created_at, l.id) < (p_before_created_at, p_before_id))
     order by l.created_at desc, l.id desc
     limit p_limit;
end;
$$;

revoke all on function private.work_item_access(uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_work_item(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.validate_work_item_content(text, text, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function private.check_work_item_parent(uuid, public.work_item_type, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.audit_work_item(uuid, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.list_work_items(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.get_work_item(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_work_item_children(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_work_item_parent_options(uuid, public.work_item_type, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.create_work_item(uuid, public.work_item_type, text, text, uuid, public.work_item_status, public.project_priority, uuid, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function private.update_work_item(uuid, text, text, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function private.change_work_item_status(uuid, public.work_item_status) from public, anon, authenticated, service_role;
revoke all on function private.assign_work_item(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.change_work_item_priority(uuid, public.project_priority) from public, anon, authenticated, service_role;
revoke all on function private.set_work_item_hierarchy(uuid, public.work_item_type, uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_work_item_archived(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.list_project_activity(uuid, timestamptz, uuid, integer, uuid) from public, anon, authenticated, service_role;

grant execute on function private.list_work_items(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, boolean, text, integer, integer) to authenticated;
grant execute on function private.get_work_item(uuid) to authenticated;
grant execute on function private.list_work_item_children(uuid) to authenticated;
grant execute on function private.list_work_item_parent_options(uuid, public.work_item_type, text, uuid, integer) to authenticated;
grant execute on function private.create_work_item(uuid, public.work_item_type, text, text, uuid, public.work_item_status, public.project_priority, uuid, date, date, numeric) to authenticated;
grant execute on function private.update_work_item(uuid, text, text, date, date, numeric) to authenticated;
grant execute on function private.change_work_item_status(uuid, public.work_item_status) to authenticated;
grant execute on function private.assign_work_item(uuid, uuid) to authenticated;
grant execute on function private.change_work_item_priority(uuid, public.project_priority) to authenticated;
grant execute on function private.set_work_item_hierarchy(uuid, public.work_item_type, uuid) to authenticated;
grant execute on function private.set_work_item_archived(uuid, boolean) to authenticated;
grant execute on function private.list_project_activity(uuid, timestamptz, uuid, integer, uuid) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 7. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_work_items(
  p_project_id uuid,
  p_search text default null,
  p_type public.work_item_type default null,
  p_status public.work_item_status default null,
  p_priority public.project_priority default null,
  p_assignee_id uuid default null,
  p_unassigned boolean default false,
  p_archived boolean default false,
  p_sort text default 'updated_desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  id uuid, issue_key text, issue_number integer, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  parent_id uuid, parent_issue_key text, assignee_id uuid, assignee_name text,
  due_date date, estimate numeric, child_count integer,
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  select l.id, l.issue_key, l.issue_number, l.type, l.title, l.status, l.priority, l.parent_id, l.parent_issue_key,
         l.assignee_id, l.assignee_name, l.due_date, l.estimate, l.child_count, l.created_at, l.updated_at,
         l.archived_at, l.total_count
    from private.list_work_items(p_project_id, p_search, p_type, p_status, p_priority, p_assignee_id,
                                 p_unassigned, p_archived, p_sort, p_page, p_page_size) as l
$$;

create function public.get_work_item(p_work_item_id uuid)
returns table (
  id uuid, project_id uuid, issue_key text, issue_number integer, type public.work_item_type,
  title text, description text, status public.work_item_status, blocked_from_status public.work_item_status,
  priority public.project_priority,
  parent_id uuid, parent_issue_key text, parent_title text, parent_type public.work_item_type,
  assignee_id uuid, assignee_name text, assignee_email text, assignee_is_eligible boolean,
  reporter_id uuid, reporter_name text,
  start_date date, due_date date, estimate numeric,
  created_at timestamptz, updated_at timestamptz, completed_at timestamptz, archived_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select g.id, g.project_id, g.issue_key, g.issue_number, g.type, g.title, g.description, g.status,
         g.blocked_from_status, g.priority, g.parent_id, g.parent_issue_key, g.parent_title, g.parent_type,
         g.assignee_id, g.assignee_name, g.assignee_email, g.assignee_is_eligible, g.reporter_id, g.reporter_name,
         g.start_date, g.due_date, g.estimate, g.created_at, g.updated_at, g.completed_at, g.archived_at
    from private.get_work_item(p_work_item_id) as g
$$;

create function public.list_work_item_children(p_work_item_id uuid)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority, assignee_name text, archived_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select c.id, c.issue_key, c.type, c.title, c.status, c.priority, c.assignee_name, c.archived_at
    from private.list_work_item_children(p_work_item_id) as c
$$;

create function public.list_work_item_parent_options(
  p_project_id uuid, p_child_type public.work_item_type, p_search text default null,
  p_exclude_id uuid default null, p_limit integer default 20
)
returns table (id uuid, issue_key text, type public.work_item_type, title text)
language sql stable security invoker set search_path = ''
as $$
  select o.id, o.issue_key, o.type, o.title
    from private.list_work_item_parent_options(p_project_id, p_child_type, p_search, p_exclude_id, p_limit) as o
$$;

create function public.create_work_item(
  p_project_id uuid,
  p_type public.work_item_type,
  p_title text,
  p_description text default null,
  p_parent_id uuid default null,
  p_status public.work_item_status default 'BACKLOG',
  p_priority public.project_priority default 'medium',
  p_assignee_id uuid default null,
  p_start_date date default null,
  p_due_date date default null,
  p_estimate numeric default null
)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.create_work_item(p_project_id, p_type, p_title, p_description, p_parent_id, p_status,
                                  p_priority, p_assignee_id, p_start_date, p_due_date, p_estimate)
$$;

create function public.update_work_item(
  p_work_item_id uuid, p_title text, p_description text default null,
  p_start_date date default null, p_due_date date default null, p_estimate numeric default null
)
returns uuid
language sql volatile security invoker set search_path = ''
as $$
  select private.update_work_item(p_work_item_id, p_title, p_description, p_start_date, p_due_date, p_estimate)
$$;

create function public.change_work_item_status(p_work_item_id uuid, p_status public.work_item_status)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.change_work_item_status(p_work_item_id, p_status) $$;

create function public.assign_work_item(p_work_item_id uuid, p_assignee_id uuid default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.assign_work_item(p_work_item_id, p_assignee_id) $$;

create function public.change_work_item_priority(p_work_item_id uuid, p_priority public.project_priority)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.change_work_item_priority(p_work_item_id, p_priority) $$;

create function public.set_work_item_hierarchy(p_work_item_id uuid, p_type public.work_item_type, p_parent_id uuid default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.set_work_item_hierarchy(p_work_item_id, p_type, p_parent_id) $$;

create function public.archive_work_item(p_work_item_id uuid)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.set_work_item_archived(p_work_item_id, true) $$;

create function public.restore_work_item(p_work_item_id uuid)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.set_work_item_archived(p_work_item_id, false) $$;

create function public.list_project_activity(
  p_project_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20,
  p_work_item_id uuid default null
)
returns table (
  id uuid, action text, created_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  subject_name text, previous_subject_name text, changes jsonb,
  work_item_id uuid, work_item_key text, work_item_title text
)
language sql stable security invoker set search_path = ''
as $$
  select a.id, a.action, a.created_at, a.actor_id, a.actor_name, a.actor_avatar_kind, a.actor_avatar_symbol,
         a.subject_name, a.previous_subject_name, a.changes, a.work_item_id, a.work_item_key, a.work_item_title
    from private.list_project_activity(p_project_id, p_before_created_at, p_before_id, p_limit, p_work_item_id) as a
$$;

revoke all on function public.list_work_items(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_work_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_work_item_children(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_work_item_parent_options(uuid, public.work_item_type, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.create_work_item(uuid, public.work_item_type, text, text, uuid, public.work_item_status, public.project_priority, uuid, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function public.update_work_item(uuid, text, text, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function public.change_work_item_status(uuid, public.work_item_status) from public, anon, authenticated, service_role;
revoke all on function public.assign_work_item(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.change_work_item_priority(uuid, public.project_priority) from public, anon, authenticated, service_role;
revoke all on function public.set_work_item_hierarchy(uuid, public.work_item_type, uuid) from public, anon, authenticated, service_role;
revoke all on function public.archive_work_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.restore_work_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_project_activity(uuid, timestamptz, uuid, integer, uuid) from public, anon, authenticated, service_role;

grant execute on function public.list_work_items(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, boolean, text, integer, integer) to authenticated;
grant execute on function public.get_work_item(uuid) to authenticated;
grant execute on function public.list_work_item_children(uuid) to authenticated;
grant execute on function public.list_work_item_parent_options(uuid, public.work_item_type, text, uuid, integer) to authenticated;
grant execute on function public.create_work_item(uuid, public.work_item_type, text, text, uuid, public.work_item_status, public.project_priority, uuid, date, date, numeric) to authenticated;
grant execute on function public.update_work_item(uuid, text, text, date, date, numeric) to authenticated;
grant execute on function public.change_work_item_status(uuid, public.work_item_status) to authenticated;
grant execute on function public.assign_work_item(uuid, uuid) to authenticated;
grant execute on function public.change_work_item_priority(uuid, public.project_priority) to authenticated;
grant execute on function public.set_work_item_hierarchy(uuid, public.work_item_type, uuid) to authenticated;
grant execute on function public.archive_work_item(uuid) to authenticated;
grant execute on function public.restore_work_item(uuid) to authenticated;
grant execute on function public.list_project_activity(uuid, timestamptz, uuid, integer, uuid) to authenticated;

comment on function public.list_work_items(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, boolean, text, integer, integer) is
  'Work items of one project (filters, sort, offset pagination). SA, assigned PM or member developer.';
comment on function public.create_work_item(uuid, public.work_item_type, text, text, uuid, public.work_item_status, public.project_priority, uuid, date, date, numeric) is
  'Create a work item; key assigned by the database. SA/assigned PM: any type. Member developer: TASK or BUG, self/unassigned.';
comment on function public.list_project_activity(uuid, timestamptz, uuid, integer, uuid) is
  'Project activity, newest first, keyset-paginated by (created_at, id); optional work item filter. SA, assigned PM or member developer.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres). Deletes all work item data.
--   1. Drop the public wrappers created above, then (with the temporary
--      cyclo_project_api membership) the private functions.
--   2. Re-create list_project_activity / project_activity_changes from
--      20261127100000_project_activity_feed.sql.
--   3. delete from private.project_audit_log where work_item_id is not null;
--      drop the work_item_scope constraint, restore the Phase 8B action check,
--      drop column work_item_id.
--   4. drop table public.work_items, private.work_item_transitions,
--      private.work_item_counters; drop the guard/delete functions and
--      private.work_item_parent_allowed; drop types work_item_status, work_item_type.
-- =============================================================================
