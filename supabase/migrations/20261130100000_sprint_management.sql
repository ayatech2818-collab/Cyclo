-- =============================================================================
-- CYCLO Phase 8F1: sprint management foundation (local deployment only)
--
-- Model
--   * public.sprints: one project each; lifecycle PLANNING -> ACTIVE -> COMPLETED,
--     or PLANNING -> CANCELLED. Never deleted. COMPLETED/CANCELLED rows are
--     frozen (no field may change). ACTIVE sprints may change name, goal, end
--     date and capacity, but not the start date.
--   * Dates are optional while planning; ACTIVE/COMPLETED sprints always have
--     both, and start_date < end_date whenever both are set.
--   * At most one ACTIVE sprint per project: partial unique index. Two
--     concurrent starts cannot both commit; the loser gets 'active_sprint_exists'.
--   * capacity_points: optional, set explicitly by a manager. A planning
--     indicator only; never blocks planning.
--
-- Work item membership: work_items.sprint_id (nullable). A work item belongs
-- to at most one sprint by construction. A composite FK (project_id, sprint_id)
-- keeps sprints and items in the same project.
--   Schedulable (enforced by trigger for every writer, when an item is put into
--   a sprint): type STORY, TASK or BUG; not archived; status not DONE/CANCELLED;
--   target sprint PLANNING or ACTIVE. Epics group work and subtasks travel with
--   their task, so neither is scheduled directly.
--   Membership changes never change status. Done/cancelled items stay attached
--   to their completed sprint as history; the backlog lists only items with no
--   sprint.
--
-- Lifecycle rules (RPCs)
--   start     PLANNING -> ACTIVE: dates set and valid, at least one item
--             (an empty sprint has nothing to track; add work first), no other
--             ACTIVE sprint. Item statuses are untouched.
--   complete  ACTIVE -> COMPLETED: unfinished items (status not DONE/CANCELLED)
--             must be explicitly carried to the backlog or a PLANNING sprint;
--             the RPC refuses without that decision. Nothing is marked DONE.
--   cancel    PLANNING -> CANCELLED: items return to the backlog (audited per item).
--
-- Permissions: read = SA, assigned PM, member developers (Phase 8B rules);
-- every write = SA or assigned PM. Archived projects are read-only.
--
-- Audit: reuses private.project_audit_log (adds nullable sprint_id).
--   SPRINT_CREATED, SPRINT_UPDATED, SPRINT_CAPACITY_CHANGED, SPRINT_STARTED,
--   SPRINT_COMPLETED, SPRINT_CANCELLED, WORK_ITEM_ADDED_TO_SPRINT,
--   WORK_ITEM_REMOVED_FROM_SPRINT, WORK_ITEM_MOVED_BETWEEN_SPRINTS.
--   list_project_activity returns sprint_id / sprint_name (return type change:
--   dropped and re-created with the same parameters and access rules).
--
-- Changed (same signatures): private.backlog_items excludes items in a sprint;
-- private.project_activity_changes knows sprint fields.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Sprints
-- -----------------------------------------------------------------------------
create type public.sprint_status as enum ('PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

create table public.sprints (
  id              uuid        primary key default gen_random_uuid(),
  project_id      uuid        not null references public.projects (id) on delete restrict,
  name            text        not null,
  goal            text,
  status          public.sprint_status not null default 'PLANNING',
  start_date      date,
  end_date        date,
  capacity_points numeric(6, 1),
  created_by      uuid        not null references public.profiles (id) on delete restrict,
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint sprints_project_id_id_key unique (project_id, id),
  constraint sprints_name_valid check (name = btrim(name) and char_length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
  constraint sprints_goal_valid check (goal is null or char_length(btrim(goal)) between 1 and 2000),
  constraint sprints_dates_ordered check (start_date is null or end_date is null or start_date < end_date),
  constraint sprints_capacity_range check (capacity_points is null or (capacity_points >= 0 and capacity_points <= 10000)),
  constraint sprints_lifecycle check (
    case status
      when 'PLANNING'  then started_at is null and completed_at is null and cancelled_at is null
      when 'ACTIVE'    then started_at is not null and completed_at is null and cancelled_at is null
                            and start_date is not null and end_date is not null
      when 'COMPLETED' then started_at is not null and completed_at is not null and cancelled_at is null
                            and start_date is not null and end_date is not null
      when 'CANCELLED' then started_at is null and completed_at is null and cancelled_at is not null
    end
  )
);

comment on table public.sprints is
  'Project sprints. Writes only through sprint RPCs; never deleted. COMPLETED/CANCELLED rows are immutable.';

create unique index sprints_one_active_per_project on public.sprints (project_id) where status = 'ACTIVE';
create index sprints_project_status_idx on public.sprints (project_id, status, start_date);
create index sprints_created_by_idx on public.sprints (created_by);

create trigger sprints_set_updated_at
  before update on public.sprints
  for each row execute function private.set_updated_at();

create function private.guard_sprint_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '22023', message = 'sprint_identity_immutable';
  end if;

  if old.status in ('COMPLETED', 'CANCELLED') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;

  if new.status is distinct from old.status
     and not ((old.status = 'PLANNING' and new.status in ('ACTIVE', 'CANCELLED'))
              or (old.status = 'ACTIVE' and new.status = 'COMPLETED')) then
    raise exception using errcode = '22023', message = 'invalid_sprint_transition';
  end if;

  if old.status = 'ACTIVE' and new.start_date is distinct from old.start_date then
    raise exception using errcode = '55000', message = 'sprint_started';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_sprint_row() from public, anon, authenticated, service_role;

create trigger sprints_guard_row
  before update on public.sprints
  for each row execute function private.guard_sprint_row();

create function private.prevent_sprint_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'Sprints cannot be deleted. Cancel or complete the sprint instead.',
    constraint = 'sprints_no_delete';
end;
$$;
revoke all on function private.prevent_sprint_delete() from public, anon, authenticated, service_role;

create trigger sprints_prevent_delete before delete on public.sprints for each row execute function private.prevent_sprint_delete();
create trigger sprints_prevent_truncate before truncate on public.sprints for each statement execute function private.prevent_sprint_delete();
alter table public.sprints enable always trigger sprints_guard_row;
alter table public.sprints enable always trigger sprints_prevent_delete;
alter table public.sprints enable always trigger sprints_prevent_truncate;


-- -----------------------------------------------------------------------------
-- 2. Work item membership
-- -----------------------------------------------------------------------------
alter table public.work_items add column sprint_id uuid;
alter table public.work_items add constraint work_items_sprint_same_project_fkey
  foreign key (project_id, sprint_id) references public.sprints (project_id, id) on delete restrict;
create index work_items_sprint_id_idx on public.work_items (sprint_id, backlog_rank) where sprint_id is not null;
comment on column public.work_items.sprint_id is
  'Sprint the item is scheduled in (at most one). Kept after sprint completion for done/cancelled items.';

-- Owner postgres: reads sprints for every writer.
create function private.guard_work_item_sprint()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_sprint_status public.sprint_status;
begin
  if new.sprint_id is null then
    return new;
  end if;

  if TG_OP = 'INSERT' or new.sprint_id is distinct from old.sprint_id then
    select s.status into v_sprint_status from public.sprints as s
     where s.id = new.sprint_id and s.project_id = new.project_id;
    if not found then
      raise exception using errcode = '22023', message = 'invalid_sprint_id';
    end if;
    if v_sprint_status not in ('PLANNING', 'ACTIVE') then
      raise exception using errcode = '55000', message = 'sprint_closed';
    end if;
    if new.type not in ('STORY', 'TASK', 'BUG') or new.archived_at is not null
       or new.status in ('DONE', 'CANCELLED') then
      raise exception using errcode = '22023', message = 'not_schedulable';
    end if;
  elsif new.type is distinct from old.type and new.type not in ('STORY', 'TASK', 'BUG') then
    -- An item scheduled in a sprint cannot become an epic or subtask.
    raise exception using errcode = '22023', message = 'not_schedulable';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_work_item_sprint() from public, anon, authenticated, service_role;

create trigger work_items_guard_sprint
  before insert or update of sprint_id, type on public.work_items
  for each row execute function private.guard_work_item_sprint();
alter table public.work_items enable always trigger work_items_guard_sprint;


-- -----------------------------------------------------------------------------
-- 3. Privileges and RLS
-- -----------------------------------------------------------------------------
alter table public.sprints enable row level security;
revoke all on table public.sprints from public, anon, authenticated, service_role, cyclo_project_api;

grant select on table public.sprints to authenticated;
grant select on table public.sprints to service_role;

create policy "Super admins read all sprints"
  on public.sprints for select to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');
create policy "Project managers read sprints of assigned projects"
  on public.sprints for select to authenticated
  using ((select private.current_app_role()) = 'PROJECT_MANAGER' and private.is_assigned_project_manager(project_id));
create policy "Developers read sprints of their projects"
  on public.sprints for select to authenticated
  using ((select private.current_app_role()) = 'DEVELOPER' and private.is_project_member(project_id));

grant select on table public.sprints to cyclo_project_api;
grant insert (project_id, name, goal, start_date, end_date, capacity_points, created_by) on table public.sprints to cyclo_project_api;
grant update (name, goal, status, start_date, end_date, capacity_points, started_at, completed_at, cancelled_at)
  on table public.sprints to cyclo_project_api;
create policy "Project API role reads sprints" on public.sprints for select to cyclo_project_api using (true);
create policy "Project API role creates sprints" on public.sprints for insert to cyclo_project_api with check (true);
create policy "Project API role updates sprints" on public.sprints for update to cyclo_project_api using (true) with check (true);

grant update (sprint_id) on table public.work_items to cyclo_project_api;


-- -----------------------------------------------------------------------------
-- 4. Audit
-- -----------------------------------------------------------------------------
alter table private.project_audit_log add column sprint_id uuid;
comment on column private.project_audit_log.sprint_id is 'Set for SPRINT_* actions. No FK: history outlives rows.';
create index project_audit_log_sprint_created_idx on private.project_audit_log (sprint_id, created_at desc) where sprint_id is not null;

alter table private.project_audit_log drop constraint project_audit_log_action_check;
alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
  'PROJECT_ARCHIVED', 'PROJECT_RESTORED',
  'PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED',
  'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED', 'WORK_ITEM_PARENT_CHANGED',
  'WORK_ITEM_ASSIGNED', 'WORK_ITEM_PRIORITY_CHANGED', 'WORK_ITEM_STATUS_CHANGED',
  'WORK_ITEM_ARCHIVED', 'WORK_ITEM_RESTORED', 'WORK_ITEM_REORDERED',
  'WORK_ITEM_ADDED_TO_SPRINT', 'WORK_ITEM_REMOVED_FROM_SPRINT', 'WORK_ITEM_MOVED_BETWEEN_SPRINTS',
  'SPRINT_CREATED', 'SPRINT_UPDATED', 'SPRINT_CAPACITY_CHANGED',
  'SPRINT_STARTED', 'SPRINT_COMPLETED', 'SPRINT_CANCELLED'));
alter table private.project_audit_log add constraint project_audit_log_sprint_scope check (
  (action like 'SPRINT_%') = (sprint_id is not null));

grant insert (sprint_id) on private.project_audit_log to cyclo_project_api;


-- -----------------------------------------------------------------------------
-- 5. Implementations (owner cyclo_project_api; same transfer pattern)
-- -----------------------------------------------------------------------------
-- The Phase 8C wrapper (owner postgres) is re-created below with more columns.
drop function public.list_project_activity(uuid, timestamptz, uuid, integer, uuid);

grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Backlog = schedulable open items that are not in any sprint (Phase 8E, extended).
create or replace function private.backlog_items(p_project_id uuid, p_include_completed boolean)
returns table (
  id uuid, issue_key text, issue_number integer, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  assignee_id uuid, estimate numeric, backlog_rank numeric, epic_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.issue_key, w.issue_number, w.type, w.title, w.status, w.priority,
         w.assignee_id, w.estimate, w.backlog_rank,
         case when p1.type = 'EPIC' then p1.id
              when p2.type = 'EPIC' then p2.id
              when p3.type = 'EPIC' then p3.id end
    from public.work_items as w
    left join public.work_items as p1 on p1.id = w.parent_id
    left join public.work_items as p2 on p2.id = p1.parent_id
    left join public.work_items as p3 on p3.id = p2.parent_id
   where w.project_id = p_project_id
     and w.archived_at is null
     and w.sprint_id is null
     and w.type in ('STORY', 'TASK', 'BUG')
     and (p_include_completed or w.status not in ('DONE', 'CANCELLED'))
$$;

-- Caller's capabilities for one sprint; P0002 'sprint_not_found' when not visible.
create function private.sprint_access(p_sprint_id uuid, p_lock boolean,
  out project_id uuid, out actor_id uuid, out is_manager boolean, out status public.sprint_status)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_sprint_id is null then
    raise exception using errcode = '22023', message = 'invalid_sprint_id';
  end if;
  select s.project_id into project_id from public.sprints as s where s.id = p_sprint_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'sprint_not_found';
  end if;
  begin
    select a.actor_id, a.is_manager into actor_id, is_manager from private.work_item_access(project_id) as a;
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'sprint_not_found';
  end;
  if p_lock then
    select s.status into status from public.sprints as s where s.id = p_sprint_id for update;
  else
    select s.status into status from public.sprints as s where s.id = p_sprint_id;
  end if;
end;
$$;

-- Manager write access to a sprint (locked); archived projects are read-only.
create function private.lock_sprint_for_change(p_sprint_id uuid,
  out project_id uuid, out actor_id uuid, out status public.sprint_status)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_manager boolean;
begin
  select a.project_id, a.actor_id, a.is_manager, a.status into project_id, actor_id, v_manager, status
    from private.sprint_access(p_sprint_id, true) as a;
  if not v_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if exists (select 1 from public.projects as pr where pr.id = project_id and pr.archived_at is not null) then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;
end;
$$;

create function private.validate_sprint_fields(p_name text, p_goal text, p_start date, p_end date,
  out v_name text, out v_goal text)
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  v_name := private.trim_text(p_name);
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_sprint_name';
  end if;
  v_goal := nullif(private.trim_text(p_goal), '');
  if v_goal is not null and pg_catalog.char_length(v_goal) > 2000 then
    raise exception using errcode = '22023', message = 'invalid_sprint_goal';
  end if;
  if p_start is not null and p_end is not null and p_start >= p_end then
    raise exception using errcode = '22023', message = 'invalid_sprint_dates';
  end if;
end;
$$;

create function private.audit_sprint(p_actor uuid, p_project_id uuid, p_sprint_id uuid, p_action text, p_old jsonb, p_new jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.project_audit_log (actor_id, project_id, sprint_id, action, old_values, new_values)
  values (p_actor, p_project_id, p_sprint_id, p_action, p_old, p_new)
$$;

-- Moves one locked item to p_to (null = backlog) and records the right event.
create function private.set_item_sprint(p_actor uuid, p_project_id uuid, p_work_item_id uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.work_items as w set sprint_id = p_to where w.id = p_work_item_id;
  perform private.audit_work_item(p_actor, p_project_id, p_work_item_id,
    case when p_from is null then 'WORK_ITEM_ADDED_TO_SPRINT'
         when p_to is null then 'WORK_ITEM_REMOVED_FROM_SPRINT'
         else 'WORK_ITEM_MOVED_BETWEEN_SPRINTS' end,
    pg_catalog.jsonb_build_object('sprint_id', p_from), pg_catalog.jsonb_build_object('sprint_id', p_to));
end;
$$;

-- Validates a selection of 1..100 distinct items of one project and locks them (fixed order).
create function private.lock_sprint_selection(p_project_id uuid, p_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := coalesce(pg_catalog.cardinality(p_ids), 0);
begin
  if v_count < 1 or v_count > 100
     or exists (select 1 from pg_catalog.unnest(p_ids) as x where x is null)
     or (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_ids) as x) <> v_count then
    raise exception using errcode = '22023', message = 'invalid_selection';
  end if;
  perform 1 from public.work_items as w where w.id = any (p_ids) order by w.id for update;
  if (select pg_catalog.count(*) from public.work_items as w where w.id = any (p_ids) and w.project_id = p_project_id) <> v_count then
    raise exception using errcode = '22023', message = 'invalid_selection';
  end if;
end;
$$;

create function private.sprint_rows(p_project_id uuid)
returns table (
  id uuid, name text, goal text, status public.sprint_status, start_date date, end_date date,
  capacity_points numeric, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz, item_count integer, done_count integer, estimate_total numeric,
  done_estimate numeric, unestimated_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.name, s.goal, s.status, s.start_date, s.end_date, s.capacity_points,
         s.started_at, s.completed_at, s.cancelled_at, s.created_at,
         coalesce(i.item_count, 0), coalesce(i.done_count, 0), i.estimate_total, i.done_estimate,
         coalesce(i.unestimated_count, 0)
    from public.sprints as s
    left join lateral (
      select pg_catalog.count(*)::integer as item_count,
             (pg_catalog.count(*) filter (where w.status = 'DONE'))::integer as done_count,
             pg_catalog.sum(w.estimate) as estimate_total,
             pg_catalog.sum(w.estimate) filter (where w.status = 'DONE') as done_estimate,
             (pg_catalog.count(*) filter (where w.estimate is null))::integer as unestimated_count
        from public.work_items as w
       where w.sprint_id = s.id and w.archived_at is null
    ) as i on true
   where s.project_id = p_project_id
$$;

create function private.list_sprints(p_project_id uuid, p_scope text, p_page integer, p_page_size integer)
returns table (
  id uuid, name text, goal text, status public.sprint_status, start_date date, end_date date,
  capacity_points numeric, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz, item_count integer, done_count integer, estimate_total numeric,
  done_estimate numeric, unestimated_count integer, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.work_item_access(p_project_id);
  if p_scope is null or p_scope not in ('open', 'closed', 'all') then
    raise exception using errcode = '22023', message = 'invalid_scope';
  end if;
  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  return query
    select r.*, pg_catalog.count(*) over ()
      from private.sprint_rows(p_project_id) as r
     where p_scope = 'all'
        or (p_scope = 'open' and r.status in ('PLANNING', 'ACTIVE'))
        or (p_scope = 'closed' and r.status in ('COMPLETED', 'CANCELLED'))
     order by
       case r.status when 'ACTIVE' then 0 when 'PLANNING' then 1 else 2 end,
       case when r.status = 'PLANNING' then r.start_date end asc nulls last,
       coalesce(r.completed_at, r.cancelled_at) desc nulls last,
       r.created_at asc, r.id
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;

create function private.get_sprint(p_sprint_id uuid)
returns table (
  id uuid, project_id uuid, name text, goal text, status public.sprint_status, start_date date, end_date date,
  capacity_points numeric, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz, created_by_name text, item_count integer, done_count integer,
  estimate_total numeric, done_estimate numeric, unestimated_count integer
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
  if p_sprint_id is null then
    raise exception using errcode = '22023', message = 'invalid_sprint_id';
  end if;
  select s.project_id into v_project from public.sprints as s where s.id = p_sprint_id;
  if not found then
    return;
  end if;
  begin
    perform private.work_item_access(v_project);
  exception when sqlstate 'P0002' then
    return;
  end;
  return query
    select r.id, v_project, r.name, r.goal, r.status, r.start_date, r.end_date, r.capacity_points,
           r.started_at, r.completed_at, r.cancelled_at, r.created_at,
           coalesce(cb.full_name, cb.email), r.item_count, r.done_count, r.estimate_total, r.done_estimate,
           r.unestimated_count
      from private.sprint_rows(v_project) as r
      join public.sprints as s on s.id = r.id
      left join public.profiles as cb on cb.id = s.created_by
     where r.id = p_sprint_id;
end;
$$;

create function private.list_sprint_items(p_sprint_id uuid, p_page integer, p_page_size integer)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text, status public.work_item_status,
  priority public.project_priority, assignee_id uuid, assignee_name text, estimate numeric,
  archived_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.sprint_access(p_sprint_id, false);
  if p_page is null or p_page < 1 or p_page > 100000 or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;
  return query
    select w.id, w.issue_key, w.type, w.title, w.status, w.priority, w.assignee_id,
           coalesce(a.full_name, a.email), w.estimate, w.archived_at, pg_catalog.count(*) over ()
      from public.work_items as w
      left join public.profiles as a on a.id = w.assignee_id
     where w.sprint_id = p_sprint_id
     order by (w.archived_at is not null), w.backlog_rank, w.issue_number
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;

-- Planned points per assignee (null assignee = unassigned).
create function private.sprint_capacity(p_sprint_id uuid)
returns table (assignee_id uuid, assignee_name text, item_count integer, estimate_total numeric, unestimated_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.sprint_access(p_sprint_id, false);
  return query
    select w.assignee_id, coalesce(a.full_name, a.email), pg_catalog.count(*)::integer, pg_catalog.sum(w.estimate),
           (pg_catalog.count(*) filter (where w.estimate is null))::integer
      from public.work_items as w
      left join public.profiles as a on a.id = w.assignee_id
     where w.sprint_id = p_sprint_id and w.archived_at is null
     group by w.assignee_id, a.full_name, a.email
     order by pg_catalog.sum(w.estimate) desc nulls last, coalesce(a.full_name, a.email) nulls last;
end;
$$;

create function private.create_sprint(p_project_id uuid, p_name text, p_goal text, p_start date, p_end date, p_capacity numeric)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_manager boolean;
  v_fields record;
  v_id uuid;
begin
  if p_project_id is null then
    raise exception using errcode = '22023', message = 'invalid_project_id';
  end if;
  select a.actor_id, a.is_manager into v_actor, v_manager from private.work_item_access(p_project_id) as a;
  if not v_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if exists (select 1 from public.projects as pr where pr.id = p_project_id and pr.archived_at is not null) then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;
  select * into v_fields from private.validate_sprint_fields(p_name, p_goal, p_start, p_end);
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 10000 or p_capacity <> round(p_capacity, 1)) then
    raise exception using errcode = '22023', message = 'invalid_capacity';
  end if;

  insert into public.sprints (project_id, name, goal, start_date, end_date, capacity_points, created_by)
  values (p_project_id, v_fields.v_name, v_fields.v_goal, p_start, p_end, p_capacity, v_actor)
  returning sprints.id into v_id;

  perform private.audit_sprint(v_actor, p_project_id, v_id, 'SPRINT_CREATED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('name', v_fields.v_name, 'goal', v_fields.v_goal, 'start_date', p_start,
      'end_date', p_end, 'capacity_points', p_capacity));
  return v_id;
end;
$$;

create function private.update_sprint(p_sprint_id uuid, p_name text, p_goal text, p_start date, p_end date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_fields record;
  v_old jsonb;
  v_diff record;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status not in ('PLANNING', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;
  select * into v_fields from private.validate_sprint_fields(p_name, p_goal, p_start, p_end);
  if v_lock.status = 'ACTIVE' and (p_start is null or p_end is null) then
    raise exception using errcode = '22023', message = 'invalid_sprint_dates';
  end if;

  select pg_catalog.jsonb_build_object('name', s.name, 'goal', s.goal, 'start_date', s.start_date, 'end_date', s.end_date)
    into v_old from public.sprints as s where s.id = p_sprint_id;
  select * into v_diff from private.jsonb_changed(v_old, pg_catalog.jsonb_build_object(
    'name', v_fields.v_name, 'goal', v_fields.v_goal, 'start_date', p_start, 'end_date', p_end));
  if v_diff.new_values = '{}'::jsonb then
    return p_sprint_id;
  end if;
  -- The guard trigger refuses start_date changes on an ACTIVE sprint.
  update public.sprints as s set name = v_fields.v_name, goal = v_fields.v_goal, start_date = p_start, end_date = p_end
   where s.id = p_sprint_id;
  perform private.audit_sprint(v_lock.actor_id, v_lock.project_id, p_sprint_id, 'SPRINT_UPDATED', v_diff.old_values, v_diff.new_values);
  return p_sprint_id;
end;
$$;

create function private.set_sprint_capacity(p_sprint_id uuid, p_capacity numeric)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_old numeric;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status not in ('PLANNING', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 10000 or p_capacity <> round(p_capacity, 1)) then
    raise exception using errcode = '22023', message = 'invalid_capacity';
  end if;
  select s.capacity_points into v_old from public.sprints as s where s.id = p_sprint_id;
  if v_old is not distinct from p_capacity then
    return p_sprint_id;
  end if;
  update public.sprints as s set capacity_points = p_capacity where s.id = p_sprint_id;
  perform private.audit_sprint(v_lock.actor_id, v_lock.project_id, p_sprint_id, 'SPRINT_CAPACITY_CHANGED',
    pg_catalog.jsonb_build_object('capacity_points', v_old), pg_catalog.jsonb_build_object('capacity_points', p_capacity));
  return p_sprint_id;
end;
$$;

-- Adds backlog items (not in any sprint) to an open sprint. All or nothing.
create function private.add_work_items_to_sprint(p_sprint_id uuid, p_work_item_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_item record;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status not in ('PLANNING', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;
  perform private.lock_sprint_selection(v_lock.project_id, p_work_item_ids);

  for v_item in select w.id, w.sprint_id, w.type, w.status, w.archived_at from public.work_items as w
                 where w.id = any (p_work_item_ids) order by w.id loop
    if v_item.sprint_id = p_sprint_id then
      raise exception using errcode = '23505', message = 'already_in_sprint';
    end if;
    if v_item.sprint_id is not null then
      raise exception using errcode = '22023', message = 'in_another_sprint';
    end if;
    if v_item.type not in ('STORY', 'TASK', 'BUG') or v_item.archived_at is not null or v_item.status in ('DONE', 'CANCELLED') then
      raise exception using errcode = '22023', message = 'not_schedulable';
    end if;
    perform private.set_item_sprint(v_lock.actor_id, v_lock.project_id, v_item.id, null, p_sprint_id);
  end loop;
  return pg_catalog.cardinality(p_work_item_ids);
end;
$$;

-- Returns items of an open sprint to the backlog (status unchanged). All or nothing.
create function private.remove_work_items_from_sprint(p_sprint_id uuid, p_work_item_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_id uuid;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status not in ('PLANNING', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;
  perform private.lock_sprint_selection(v_lock.project_id, p_work_item_ids);
  if exists (select 1 from public.work_items as w where w.id = any (p_work_item_ids) and w.sprint_id is distinct from p_sprint_id) then
    raise exception using errcode = '22023', message = 'not_in_sprint';
  end if;
  for v_id in select x from pg_catalog.unnest(p_work_item_ids) as x order by x loop
    perform private.set_item_sprint(v_lock.actor_id, v_lock.project_id, v_id, p_sprint_id, null);
  end loop;
  return pg_catalog.cardinality(p_work_item_ids);
end;
$$;

-- Moves items from one open sprint to another open sprint of the same project, atomically.
create function private.move_work_items_between_sprints(p_from_sprint_id uuid, p_to_sprint_id uuid, p_work_item_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_from record;
  v_to record;
  v_id uuid;
begin
  if p_from_sprint_id is null or p_to_sprint_id is null or p_from_sprint_id = p_to_sprint_id then
    raise exception using errcode = '22023', message = 'invalid_sprint_id';
  end if;
  -- Lock both sprints in a fixed order.
  if p_from_sprint_id < p_to_sprint_id then
    select * into v_from from private.lock_sprint_for_change(p_from_sprint_id);
    select * into v_to from private.lock_sprint_for_change(p_to_sprint_id);
  else
    select * into v_to from private.lock_sprint_for_change(p_to_sprint_id);
    select * into v_from from private.lock_sprint_for_change(p_from_sprint_id);
  end if;
  if v_from.project_id <> v_to.project_id then
    raise exception using errcode = '22023', message = 'invalid_sprint_id';
  end if;
  if v_from.status not in ('PLANNING', 'ACTIVE') or v_to.status not in ('PLANNING', 'ACTIVE') then
    raise exception using errcode = '55000', message = 'sprint_closed';
  end if;
  perform private.lock_sprint_selection(v_from.project_id, p_work_item_ids);
  if exists (select 1 from public.work_items as w where w.id = any (p_work_item_ids) and w.sprint_id is distinct from p_from_sprint_id) then
    raise exception using errcode = '22023', message = 'not_in_sprint';
  end if;
  for v_id in select x from pg_catalog.unnest(p_work_item_ids) as x order by x loop
    -- The trigger re-checks schedulability (e.g. done items cannot move on).
    perform private.set_item_sprint(v_from.actor_id, v_from.project_id, v_id, p_from_sprint_id, p_to_sprint_id);
  end loop;
  return pg_catalog.cardinality(p_work_item_ids);
end;
$$;

create function private.start_sprint(p_sprint_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_sprint record;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status <> 'PLANNING' then
    raise exception using errcode = '22023', message = 'invalid_sprint_transition';
  end if;
  select s.start_date, s.end_date into v_sprint from public.sprints as s where s.id = p_sprint_id;
  if v_sprint.start_date is null or v_sprint.end_date is null or v_sprint.start_date >= v_sprint.end_date then
    raise exception using errcode = '22023', message = 'invalid_sprint_dates';
  end if;
  if not exists (select 1 from public.work_items as w where w.sprint_id = p_sprint_id and w.archived_at is null) then
    raise exception using errcode = '22023', message = 'sprint_empty';
  end if;
  if exists (select 1 from public.sprints as s where s.project_id = v_lock.project_id and s.status = 'ACTIVE') then
    raise exception using errcode = '23505', message = 'active_sprint_exists';
  end if;

  begin
    update public.sprints as s set status = 'ACTIVE', started_at = pg_catalog.now() where s.id = p_sprint_id;
  exception when unique_violation then
    -- A concurrent start of another sprint committed first.
    raise exception using errcode = '23505', message = 'active_sprint_exists';
  end;
  perform private.audit_sprint(v_lock.actor_id, v_lock.project_id, p_sprint_id, 'SPRINT_STARTED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('start_date', v_sprint.start_date, 'end_date', v_sprint.end_date));
  return p_sprint_id;
end;
$$;

-- p_carry_over: 'backlog' or 'sprint' (then p_target_sprint_id, a PLANNING sprint).
-- Required whenever unfinished items exist; nothing is ever marked DONE.
create function private.complete_sprint(p_sprint_id uuid, p_carry_over text, p_target_sprint_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_target record;
  v_unfinished uuid[];
  v_done integer;
  v_id uuid;
  v_archived boolean;
begin
  -- Fixed lock order with the target sprint.
  if p_target_sprint_id is not null and p_target_sprint_id < p_sprint_id then
    perform private.lock_sprint_for_change(p_target_sprint_id);
  end if;
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status <> 'ACTIVE' then
    raise exception using errcode = '22023', message = 'invalid_sprint_transition';
  end if;

  select pg_catalog.array_agg(w.id order by w.id) into v_unfinished from public.work_items as w
   where w.sprint_id = p_sprint_id and w.status not in ('DONE', 'CANCELLED');
  perform 1 from public.work_items as w where w.id = any (coalesce(v_unfinished, '{}')) order by w.id for update;

  if v_unfinished is not null then
    if p_carry_over is null or p_carry_over not in ('backlog', 'sprint') then
      raise exception using errcode = '22023', message = 'unfinished_work_requires_decision';
    end if;
    if p_carry_over = 'sprint' then
      if p_target_sprint_id is null or p_target_sprint_id = p_sprint_id then
        raise exception using errcode = '22023', message = 'invalid_carry_over_sprint';
      end if;
      select * into v_target from private.lock_sprint_for_change(p_target_sprint_id);
      if v_target.project_id <> v_lock.project_id or v_target.status <> 'PLANNING' then
        raise exception using errcode = '22023', message = 'invalid_carry_over_sprint';
      end if;
    end if;
    -- Archived leftovers cannot be scheduled again; they return to the backlog (still audited).
    for v_id, v_archived in select w.id, w.archived_at is not null from public.work_items as w
                             where w.id = any (v_unfinished) order by w.id loop
      perform private.set_item_sprint(v_lock.actor_id, v_lock.project_id, v_id, p_sprint_id,
        case when p_carry_over = 'sprint' and not v_archived then p_target_sprint_id end);
    end loop;
  end if;

  select pg_catalog.count(*)::integer into v_done from public.work_items as w where w.sprint_id = p_sprint_id;
  update public.sprints as s set status = 'COMPLETED', completed_at = pg_catalog.now() where s.id = p_sprint_id;
  perform private.audit_sprint(v_lock.actor_id, v_lock.project_id, p_sprint_id, 'SPRINT_COMPLETED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('completed_items', v_done,
      'carried_over', coalesce(pg_catalog.cardinality(v_unfinished), 0),
      'carried_to_sprint_id', case when p_carry_over = 'sprint' and v_unfinished is not null then p_target_sprint_id end));
  return coalesce(pg_catalog.cardinality(v_unfinished), 0);
end;
$$;

create function private.cancel_sprint(p_sprint_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_items uuid[];
  v_id uuid;
begin
  select * into v_lock from private.lock_sprint_for_change(p_sprint_id);
  if v_lock.status <> 'PLANNING' then
    raise exception using errcode = '22023', message = 'invalid_sprint_transition';
  end if;
  select pg_catalog.array_agg(w.id order by w.id) into v_items from public.work_items as w where w.sprint_id = p_sprint_id;
  perform 1 from public.work_items as w where w.id = any (coalesce(v_items, '{}')) order by w.id for update;
  foreach v_id in array coalesce(v_items, '{}') loop
    perform private.set_item_sprint(v_lock.actor_id, v_lock.project_id, v_id, p_sprint_id, null);
  end loop;
  update public.sprints as s set status = 'CANCELLED', cancelled_at = pg_catalog.now() where s.id = p_sprint_id;
  perform private.audit_sprint(v_lock.actor_id, v_lock.project_id, p_sprint_id, 'SPRINT_CANCELLED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('returned_items', coalesce(pg_catalog.cardinality(v_items), 0)));
  return coalesce(pg_catalog.cardinality(v_items), 0);
end;
$$;

-- Activity change details (8C/8D/8E) extended with sprint fields.
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
               -- Presence/changed only: free text is never returned.
               when f.field in ('description', 'goal') then pg_catalog.jsonb_build_object('field', f.field)
               else pg_catalog.jsonb_build_object('field', f.field,
                      'from', pg_catalog.to_jsonb(p_old ->> f.field), 'to', pg_catalog.to_jsonb(p_new ->> f.field))
             end as item
        from (values
          ('P', 1, 'name'), ('P', 2, 'project_key'), ('P', 5, 'status'), ('P', 6, 'priority'),
          ('P', 7, 'start_date'), ('P', 8, 'target_date'), ('P', 20, 'description'),
          ('W', 3, 'title'), ('W', 4, 'type'), ('W', 5, 'status'), ('W', 6, 'priority'), ('W', 7, 'start_date'),
          ('W', 9, 'due_date'), ('W', 10, 'estimate'), ('W', 20, 'description'),
          ('S', 1, 'name'), ('S', 7, 'start_date'), ('S', 11, 'end_date'), ('S', 12, 'capacity_points'), ('S', 21, 'goal'),
          ('C', 12, 'capacity_points'),
          ('X', 13, 'completed_items'), ('X', 14, 'carried_over'),
          ('Z', 15, 'returned_items')
        ) as f(family, ord, field)
       where f.family = case
               when p_action in ('PROJECT_CREATED', 'PROJECT_UPDATED') then 'P'
               when p_action in ('WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED',
                                 'WORK_ITEM_STATUS_CHANGED', 'WORK_ITEM_PRIORITY_CHANGED') then 'W'
               when p_action in ('SPRINT_CREATED', 'SPRINT_UPDATED') then 'S'
               when p_action = 'SPRINT_CAPACITY_CHANGED' then 'C'
               when p_action = 'SPRINT_COMPLETED' then 'X'
               when p_action = 'SPRINT_CANCELLED' then 'Z'
             end
         and (p_old ? f.field or p_new ? f.field)
         and not (p_action in ('PROJECT_CREATED', 'WORK_ITEM_CREATED', 'SPRINT_CREATED') and (p_new ->> f.field) is null)
    ) as c
$$;

drop function private.list_project_activity(uuid, timestamptz, uuid, integer, uuid);

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
  work_item_title text,
  sprint_id uuid,
  sprint_name text
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
             when l.action = 'WORK_ITEM_REORDERED' then l.new_values ->> 'before_key'
             when l.action in ('WORK_ITEM_ADDED_TO_SPRINT', 'WORK_ITEM_MOVED_BETWEEN_SPRINTS') then new_sprint.name
             when l.action = 'WORK_ITEM_REMOVED_FROM_SPRINT' then old_sprint.name
           end,
           case
             when l.action in ('PROJECT_MANAGER_CHANGED', 'WORK_ITEM_ASSIGNED')
               then coalesce(old_person.full_name, old_person.email)
             when l.action = 'WORK_ITEM_PARENT_CHANGED' then old_parent.issue_key
             when l.action = 'WORK_ITEM_REORDERED' then l.new_values ->> 'after_key'
             when l.action = 'WORK_ITEM_MOVED_BETWEEN_SPRINTS' then old_sprint.name
             when l.action = 'SPRINT_COMPLETED' then carried_to.name
           end,
           private.project_activity_changes(l.action, l.old_values, l.new_values),
           l.work_item_id,
           item.issue_key,
           item.title,
           coalesce(l.sprint_id, new_sprint.id, old_sprint.id),
           coalesce(sprint.name, new_sprint.name, old_sprint.name)
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
      left join public.sprints as sprint on sprint.id = l.sprint_id
      left join public.sprints as new_sprint on l.action like 'WORK_ITEM_%SPRINT%'
                                            and new_sprint.id = (l.new_values ->> 'sprint_id')::uuid
      left join public.sprints as old_sprint on l.action like 'WORK_ITEM_%SPRINT%'
                                            and old_sprint.id = (l.old_values ->> 'sprint_id')::uuid
      left join public.sprints as carried_to on l.action = 'SPRINT_COMPLETED'
                                            and carried_to.id = (l.new_values ->> 'carried_to_sprint_id')::uuid
     where l.project_id = p_project_id
       and (p_work_item_id is null or l.work_item_id = p_work_item_id)
       and (p_before_created_at is null
            or (l.created_at, l.id) < (p_before_created_at, p_before_id))
     order by l.created_at desc, l.id desc
     limit p_limit;
end;
$$;

revoke all on function private.sprint_access(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.lock_sprint_for_change(uuid) from public, anon, authenticated, service_role;
revoke all on function private.validate_sprint_fields(text, text, date, date) from public, anon, authenticated, service_role;
revoke all on function private.audit_sprint(uuid, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.set_item_sprint(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_sprint_selection(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.sprint_rows(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_sprints(uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.get_sprint(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_sprint_items(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.sprint_capacity(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_sprint(uuid, text, text, date, date, numeric) from public, anon, authenticated, service_role;
revoke all on function private.update_sprint(uuid, text, text, date, date) from public, anon, authenticated, service_role;
revoke all on function private.set_sprint_capacity(uuid, numeric) from public, anon, authenticated, service_role;
revoke all on function private.add_work_items_to_sprint(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.remove_work_items_from_sprint(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.move_work_items_between_sprints(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.start_sprint(uuid) from public, anon, authenticated, service_role;
revoke all on function private.complete_sprint(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cancel_sprint(uuid) from public, anon, authenticated, service_role;
revoke all on function private.list_project_activity(uuid, timestamptz, uuid, integer, uuid) from public, anon, authenticated, service_role;

grant execute on function private.list_sprints(uuid, text, integer, integer) to authenticated;
grant execute on function private.get_sprint(uuid) to authenticated;
grant execute on function private.list_sprint_items(uuid, integer, integer) to authenticated;
grant execute on function private.sprint_capacity(uuid) to authenticated;
grant execute on function private.create_sprint(uuid, text, text, date, date, numeric) to authenticated;
grant execute on function private.update_sprint(uuid, text, text, date, date) to authenticated;
grant execute on function private.set_sprint_capacity(uuid, numeric) to authenticated;
grant execute on function private.add_work_items_to_sprint(uuid, uuid[]) to authenticated;
grant execute on function private.remove_work_items_from_sprint(uuid, uuid[]) to authenticated;
grant execute on function private.move_work_items_between_sprints(uuid, uuid, uuid[]) to authenticated;
grant execute on function private.start_sprint(uuid) to authenticated;
grant execute on function private.complete_sprint(uuid, text, uuid) to authenticated;
grant execute on function private.cancel_sprint(uuid) to authenticated;
grant execute on function private.list_project_activity(uuid, timestamptz, uuid, integer, uuid) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 6. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_sprints(p_project_id uuid, p_scope text default 'all', p_page integer default 1, p_page_size integer default 50)
returns table (
  id uuid, name text, goal text, status public.sprint_status, start_date date, end_date date,
  capacity_points numeric, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz, item_count integer, done_count integer, estimate_total numeric,
  done_estimate numeric, unestimated_count integer, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_sprints(p_project_id, p_scope, p_page, p_page_size) $$;

create function public.get_sprint(p_sprint_id uuid)
returns table (
  id uuid, project_id uuid, name text, goal text, status public.sprint_status, start_date date, end_date date,
  capacity_points numeric, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz, created_by_name text, item_count integer, done_count integer,
  estimate_total numeric, done_estimate numeric, unestimated_count integer
)
language sql stable security invoker set search_path = ''
as $$ select * from private.get_sprint(p_sprint_id) $$;

create function public.list_sprint_items(p_sprint_id uuid, p_page integer default 1, p_page_size integer default 100)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text, status public.work_item_status,
  priority public.project_priority, assignee_id uuid, assignee_name text, estimate numeric,
  archived_at timestamptz, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_sprint_items(p_sprint_id, p_page, p_page_size) $$;

create function public.sprint_capacity(p_sprint_id uuid)
returns table (assignee_id uuid, assignee_name text, item_count integer, estimate_total numeric, unestimated_count integer)
language sql stable security invoker set search_path = ''
as $$ select * from private.sprint_capacity(p_sprint_id) $$;

create function public.create_sprint(p_project_id uuid, p_name text, p_goal text default null,
  p_start_date date default null, p_end_date date default null, p_capacity_points numeric default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.create_sprint(p_project_id, p_name, p_goal, p_start_date, p_end_date, p_capacity_points) $$;

create function public.update_sprint(p_sprint_id uuid, p_name text, p_goal text default null,
  p_start_date date default null, p_end_date date default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.update_sprint(p_sprint_id, p_name, p_goal, p_start_date, p_end_date) $$;

create function public.set_sprint_capacity(p_sprint_id uuid, p_capacity_points numeric default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.set_sprint_capacity(p_sprint_id, p_capacity_points) $$;

create function public.add_work_items_to_sprint(p_sprint_id uuid, p_work_item_ids uuid[])
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.add_work_items_to_sprint(p_sprint_id, p_work_item_ids) $$;

create function public.remove_work_items_from_sprint(p_sprint_id uuid, p_work_item_ids uuid[])
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.remove_work_items_from_sprint(p_sprint_id, p_work_item_ids) $$;

create function public.move_work_items_between_sprints(p_from_sprint_id uuid, p_to_sprint_id uuid, p_work_item_ids uuid[])
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.move_work_items_between_sprints(p_from_sprint_id, p_to_sprint_id, p_work_item_ids) $$;

create function public.start_sprint(p_sprint_id uuid)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.start_sprint(p_sprint_id) $$;

create function public.complete_sprint(p_sprint_id uuid, p_carry_over text default null, p_target_sprint_id uuid default null)
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.complete_sprint(p_sprint_id, p_carry_over, p_target_sprint_id) $$;

create function public.cancel_sprint(p_sprint_id uuid)
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.cancel_sprint(p_sprint_id) $$;

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
  work_item_id uuid, work_item_key text, work_item_title text, sprint_id uuid, sprint_name text
)
language sql stable security invoker set search_path = ''
as $$
  select * from private.list_project_activity(p_project_id, p_before_created_at, p_before_id, p_limit, p_work_item_id)
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.list_sprints(uuid, text, integer, integer)',
    'public.get_sprint(uuid)',
    'public.list_sprint_items(uuid, integer, integer)',
    'public.sprint_capacity(uuid)',
    'public.create_sprint(uuid, text, text, date, date, numeric)',
    'public.update_sprint(uuid, text, text, date, date)',
    'public.set_sprint_capacity(uuid, numeric)',
    'public.add_work_items_to_sprint(uuid, uuid[])',
    'public.remove_work_items_from_sprint(uuid, uuid[])',
    'public.move_work_items_between_sprints(uuid, uuid, uuid[])',
    'public.start_sprint(uuid)',
    'public.complete_sprint(uuid, text, uuid)',
    'public.cancel_sprint(uuid)',
    'public.list_project_activity(uuid, timestamptz, uuid, integer, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

comment on function public.start_sprint(uuid) is
  'PLANNING -> ACTIVE. SA or assigned PM; dates valid, at least one item, one active sprint per project. Item statuses unchanged.';
comment on function public.complete_sprint(uuid, text, uuid) is
  'ACTIVE -> COMPLETED. Unfinished items must be carried to the backlog or a planned sprint; nothing is marked done.';
comment on function public.cancel_sprint(uuid) is
  'PLANNING -> CANCELLED. Items return to the backlog. SA or assigned PM.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres). Deletes sprint data.
--   Drop the public sprint wrappers and list_project_activity; with the
--   temporary cyclo_project_api membership drop the private sprint functions,
--   re-create backlog_items, project_activity_changes and list_project_activity
--   from 20261129100000 (and its public wrapper); delete SPRINT_* and
--   WORK_ITEM_*SPRINT* audit rows, drop the sprint_scope constraint, restore the
--   8E action check and drop audit column sprint_id; drop trigger
--   work_items_guard_sprint, the FK and column work_items.sprint_id; drop table
--   public.sprints, functions guard_sprint_row / prevent_sprint_delete /
--   guard_work_item_sprint and type public.sprint_status.
-- =============================================================================
