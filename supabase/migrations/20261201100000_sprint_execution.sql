-- =============================================================================
-- CYCLO Phase 8F2: active sprint board, developer execution, progress, burndown
-- (local deployment only)
--
-- Workflow changes (tightening only; explained in the Phase 8F2 report)
--   * Review decisions are manager-only: IN_REVIEW -> DONE (approve) and
--     IN_REVIEW -> IN_PROGRESS (reject) now require SA or the assigned PM.
--     Previously the assignee could approve their own work.
--   * Blocking requires a reason: work_items.blocked_reason is set exactly while
--     status = BLOCKED (CHECK constraint, so every writer must provide one).
--   * Rejecting a review requires a reason (recorded in the audit event).
--   * The generic change_work_item_status refuses the two transitions that need
--     a reason (-> BLOCKED, IN_REVIEW -> IN_PROGRESS); they go through
--     execute_work_item. All other generic transitions are unchanged.
--
-- Execution API: execute_work_item(item, action, reason, expected_status)
--   start          TODO -> IN_PROGRESS          assignee or manager
--   submit_review  IN_PROGRESS -> IN_REVIEW     assignee or manager
--   block          TODO|IN_PROGRESS|IN_REVIEW -> BLOCKED (reason 3-500 chars)   assignee or manager
--   resume         BLOCKED -> blocked_from_status                               assignee or manager
--   approve        IN_REVIEW -> DONE            manager
--   reject         IN_REVIEW -> IN_PROGRESS (reason 3-500 chars)                manager
--   The row is locked; expected_status guards concurrent changes. A retry of a
--   request that already succeeded (item already in the action's target state
--   and expected_status = the action's source) is a no-op: no second event.
--   Developers never act on another developer's (or unassigned) work.
--   Audit: WORK_ITEM_STARTED, _SUBMITTED_FOR_REVIEW, _REVIEW_APPROVED,
--          _REVIEW_REJECTED, _BLOCKED, _RESUMED (old/new status, reason).
--
-- Burndown history (the audit log alone does not record an item's
-- (in sprint, status, estimate, archived) state at a point in time):
--   private.sprint_item_history: one row per state change of an item in an
--   ACTIVE sprint, written by database triggers only:
--     * baseline rows for every item when a sprint becomes ACTIVE;
--     * a row whenever sprint_id, status, estimate or archived_at changes for an
--       item whose old or new sprint is ACTIVE (added, removed, moved, done,
--       re-estimated, archived during the sprint).
--   sprint_burndown(sprint) replays it per UTC day: remaining = estimates of
--   items in the sprint, not archived, not DONE/CANCELLED, as of the end of that
--   day. Days before the baseline exist are returned with has_data = false
--   (never zero). Cancelled work is neither remaining nor completed.
--   Ideal line: decreases over working days (Mon-Fri) only; computed in the
--   application from the baseline scope (see src/features/sprints/burndown.ts).
--
-- Board: list_sprint_board(sprint) returns the active work of a sprint (not
-- archived, not CANCELLED), bounded to 500 items. Only ACTIVE sprints are
-- executable; the UI shows planning/closed sprints read-only elsewhere.
--
-- Progress: sprint_progress(sprint) returns a totals row and one row per
-- assignee with the same definitions the board and burndown use.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Workflow tightening
-- -----------------------------------------------------------------------------
update private.work_item_transitions set manager_only = true
 where (from_status, to_status) in (('IN_REVIEW', 'DONE'), ('IN_REVIEW', 'IN_PROGRESS'));

alter table public.work_items add column blocked_reason text;
-- Existing blocked items predate reasons; record that honestly instead of inventing one.
update public.work_items set blocked_reason = 'Reason not recorded' where status = 'BLOCKED';
alter table public.work_items add constraint work_items_blocked_reason_state check (
  (status = 'BLOCKED') = (blocked_reason is not null)
  and (blocked_reason is null or char_length(blocked_reason) between 3 and 500)
);
comment on column public.work_items.blocked_reason is 'Why the item is blocked; set exactly while status = BLOCKED.';

grant update (blocked_reason) on table public.work_items to cyclo_project_api;

create index work_items_sprint_status_idx on public.work_items (sprint_id, status) where sprint_id is not null;


-- -----------------------------------------------------------------------------
-- 2. Burndown history (owner postgres; written by triggers only)
-- -----------------------------------------------------------------------------
create table private.sprint_item_history (
  id           bigint generated always as identity primary key,
  sprint_id    uuid        not null,
  work_item_id uuid        not null,
  recorded_at  timestamptz not null default now(),
  in_sprint    boolean     not null,
  status       public.work_item_status not null,
  estimate     numeric(5, 1),
  archived     boolean     not null,
  kind         text        not null check (kind in ('baseline', 'change'))
);
comment on table private.sprint_item_history is
  'Point-in-time state of items in ACTIVE sprints, for burndown replay. Append-only; written by triggers.';
create index sprint_item_history_replay_idx on private.sprint_item_history (sprint_id, work_item_id, recorded_at desc, id desc);
alter table private.sprint_item_history enable row level security;
revoke all on private.sprint_item_history from public, anon, authenticated, service_role;
grant select on private.sprint_item_history to cyclo_project_api;
create policy project_api_read_history on private.sprint_item_history for select to cyclo_project_api using (true);

create function private.record_sprint_item_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_sprint uuid;
begin
  if new.sprint_id is not distinct from old.sprint_id and new.status is not distinct from old.status
     and new.estimate is not distinct from old.estimate and new.archived_at is not distinct from old.archived_at then
    return null;
  end if;
  for v_sprint in
    select s.id from public.sprints as s
     where s.id in (old.sprint_id, new.sprint_id) and s.status = 'ACTIVE'
  loop
    insert into private.sprint_item_history (sprint_id, work_item_id, in_sprint, status, estimate, archived, kind)
    values (v_sprint, new.id, new.sprint_id is not distinct from v_sprint, new.status, new.estimate,
            new.archived_at is not null, 'change');
  end loop;
  return null;
end;
$$;
revoke all on function private.record_sprint_item_change() from public, anon, authenticated, service_role;

create trigger work_items_record_sprint_history
  after update of sprint_id, status, estimate, archived_at on public.work_items
  for each row execute function private.record_sprint_item_change();
alter table public.work_items enable always trigger work_items_record_sprint_history;

create function private.record_sprint_baseline()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
begin
  insert into private.sprint_item_history (sprint_id, work_item_id, in_sprint, status, estimate, archived, kind)
  select new.id, w.id, true, w.status, w.estimate, w.archived_at is not null, 'baseline'
    from public.work_items as w where w.sprint_id = new.id;
  return null;
end;
$$;
revoke all on function private.record_sprint_baseline() from public, anon, authenticated, service_role;

create trigger sprints_record_baseline
  after update of status on public.sprints
  for each row when (old.status = 'PLANNING' and new.status = 'ACTIVE')
  execute function private.record_sprint_baseline();
alter table public.sprints enable always trigger sprints_record_baseline;


-- -----------------------------------------------------------------------------
-- 3. Audit actions
-- -----------------------------------------------------------------------------
alter table private.project_audit_log drop constraint project_audit_log_action_check;
alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
  'PROJECT_ARCHIVED', 'PROJECT_RESTORED',
  'PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED',
  'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED', 'WORK_ITEM_PARENT_CHANGED',
  'WORK_ITEM_ASSIGNED', 'WORK_ITEM_PRIORITY_CHANGED', 'WORK_ITEM_STATUS_CHANGED',
  'WORK_ITEM_ARCHIVED', 'WORK_ITEM_RESTORED', 'WORK_ITEM_REORDERED',
  'WORK_ITEM_ADDED_TO_SPRINT', 'WORK_ITEM_REMOVED_FROM_SPRINT', 'WORK_ITEM_MOVED_BETWEEN_SPRINTS',
  'WORK_ITEM_STARTED', 'WORK_ITEM_SUBMITTED_FOR_REVIEW', 'WORK_ITEM_REVIEW_APPROVED',
  'WORK_ITEM_REVIEW_REJECTED', 'WORK_ITEM_BLOCKED', 'WORK_ITEM_RESUMED',
  'SPRINT_CREATED', 'SPRINT_UPDATED', 'SPRINT_CAPACITY_CHANGED',
  'SPRINT_STARTED', 'SPRINT_COMPLETED', 'SPRINT_CANCELLED'));
create index project_audit_log_review_idx on private.project_audit_log (work_item_id, created_at desc)
  where action in ('WORK_ITEM_REVIEW_APPROVED', 'WORK_ITEM_REVIEW_REJECTED', 'WORK_ITEM_BLOCKED');


-- -----------------------------------------------------------------------------
-- 4. Implementations (owner cyclo_project_api; same transfer pattern)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Generic status change (Phase 8D) without the transitions that need a reason.
create or replace function private.change_work_item_status(p_work_item_id uuid, p_status public.work_item_status)
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
  -- These need a reason: use execute_work_item ('block' / 'reject').
  if p_status = 'BLOCKED' then
    raise exception using errcode = '22023', message = 'blocked_reason_required';
  end if;
  if v_old = 'IN_REVIEW' and p_status = 'IN_PROGRESS' then
    raise exception using errcode = '22023', message = 'review_reason_required';
  end if;

  update public.work_items as w
     set status = p_status, blocked_from_status = null, blocked_reason = null
   where w.id = p_work_item_id;

  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_STATUS_CHANGED',
    pg_catalog.jsonb_build_object('status', v_old), pg_catalog.jsonb_build_object('status', p_status));
  return p_work_item_id;
end;
$$;

create function private.execute_work_item(
  p_work_item_id uuid, p_action text, p_reason text, p_expected_status public.work_item_status
)
returns table (id uuid, status public.work_item_status, blocked_from_status public.work_item_status,
               blocked_reason text, updated_at timestamptz, changed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lock record;
  v_item record;
  v_from public.work_item_status[];
  v_to public.work_item_status;
  v_reason text := nullif(private.trim_text(p_reason), '');
  v_event text;
  v_manager_only boolean := p_action in ('approve', 'reject');
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if p_action is null or p_action not in ('start', 'submit_review', 'block', 'resume', 'approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  if v_manager_only and not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not (v_lock.is_manager or v_lock.is_assignee) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_expected_status is null then
    raise exception using errcode = '22023', message = 'invalid_status';
  end if;

  select w.status, w.blocked_from_status into v_item from public.work_items as w where w.id = p_work_item_id;

  case p_action
    when 'start'         then v_from := array['TODO']::public.work_item_status[];        v_to := 'IN_PROGRESS'; v_event := 'WORK_ITEM_STARTED';
    when 'submit_review' then v_from := array['IN_PROGRESS']::public.work_item_status[]; v_to := 'IN_REVIEW';   v_event := 'WORK_ITEM_SUBMITTED_FOR_REVIEW';
    when 'block'         then v_from := array['TODO', 'IN_PROGRESS', 'IN_REVIEW']::public.work_item_status[]; v_to := 'BLOCKED'; v_event := 'WORK_ITEM_BLOCKED';
    when 'resume'        then v_from := array['BLOCKED']::public.work_item_status[];     v_to := v_item.blocked_from_status; v_event := 'WORK_ITEM_RESUMED';
    when 'approve'       then v_from := array['IN_REVIEW']::public.work_item_status[];   v_to := 'DONE';        v_event := 'WORK_ITEM_REVIEW_APPROVED';
    when 'reject'        then v_from := array['IN_REVIEW']::public.work_item_status[];   v_to := 'IN_PROGRESS'; v_event := 'WORK_ITEM_REVIEW_REJECTED';
  end case;

  if p_action in ('block', 'reject') and (v_reason is null or pg_catalog.char_length(v_reason) not between 3 and 500 or v_reason ~ '[[:cntrl:]]') then
    raise exception using errcode = '22023', message = 'reason_required';
  end if;

  if v_item.status <> p_expected_status then
    -- Retry of a request that already succeeded: same source, already at the target.
    if p_expected_status = any (v_from) and p_action <> 'resume' and v_item.status = v_to then
      return query select w.id, w.status, w.blocked_from_status, w.blocked_reason, w.updated_at, false
                     from public.work_items as w where w.id = p_work_item_id;
      return;
    end if;
    -- 55000 like other state conflicts (40001 would make PostgREST treat it as a serialization failure).
    raise exception using errcode = '55000', message = 'status_changed';
  end if;
  if not (v_item.status = any (v_from)) or v_to is null then
    raise exception using errcode = '22023', message = 'invalid_transition';
  end if;

  -- The guard trigger re-validates the transition against the workflow table.
  update public.work_items as w
     set status = v_to,
         blocked_from_status = case when v_to = 'BLOCKED' then v_item.status end,
         blocked_reason = case when v_to = 'BLOCKED' then v_reason end
   where w.id = p_work_item_id;

  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, v_event,
    pg_catalog.jsonb_build_object('status', v_item.status),
    pg_catalog.jsonb_build_object('status', v_to) || case when p_action in ('block', 'reject')
      then pg_catalog.jsonb_build_object('reason', v_reason) else '{}'::jsonb end);

  return query select w.id, w.status, w.blocked_from_status, w.blocked_reason, w.updated_at, true
                 from public.work_items as w where w.id = p_work_item_id;
end;
$$;

-- Active work of a sprint for the board (bounded).
create function private.list_sprint_board(p_sprint_id uuid)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text, status public.work_item_status,
  blocked_from_status public.work_item_status, blocked_reason text, priority public.project_priority,
  assignee_id uuid, assignee_name text, estimate numeric, backlog_rank numeric, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.sprint_access(p_sprint_id, false);
  return query
    select w.id, w.issue_key, w.type, w.title, w.status, w.blocked_from_status, w.blocked_reason, w.priority,
           w.assignee_id, coalesce(a.full_name, a.email), w.estimate, w.backlog_rank, w.updated_at
      from public.work_items as w
      left join public.profiles as a on a.id = w.assignee_id
     where w.sprint_id = p_sprint_id and w.archived_at is null and w.status <> 'CANCELLED'
     order by w.backlog_rank, w.issue_number
     limit 500;
end;
$$;

-- Totals and per-assignee progress. Cancelled work is excluded from scope and
-- never counted as completed. completion_percent uses points when any work is
-- estimated, otherwise item counts.
create function private.sprint_progress(p_sprint_id uuid)
returns table (
  scope text, assignee_id uuid, assignee_name text,
  total_items integer, completed_items integer, remaining_items integer, cancelled_items integer,
  total_points numeric, completed_points numeric, remaining_points numeric, unestimated_items integer,
  completion_percent integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.sprint_access(p_sprint_id, false);
  return query
    with items as (
      select w.assignee_id, w.status, w.estimate
        from public.work_items as w where w.sprint_id = p_sprint_id and w.archived_at is null
    ), grouped as (
      select grouping(i.assignee_id) = 1 as is_total, i.assignee_id,
             (pg_catalog.count(*) filter (where i.status <> 'CANCELLED'))::integer as total_items,
             (pg_catalog.count(*) filter (where i.status = 'DONE'))::integer as completed_items,
             (pg_catalog.count(*) filter (where i.status not in ('DONE', 'CANCELLED')))::integer as remaining_items,
             (pg_catalog.count(*) filter (where i.status = 'CANCELLED'))::integer as cancelled_items,
             coalesce(pg_catalog.sum(i.estimate) filter (where i.status <> 'CANCELLED'), 0) as total_points,
             coalesce(pg_catalog.sum(i.estimate) filter (where i.status = 'DONE'), 0) as completed_points,
             coalesce(pg_catalog.sum(i.estimate) filter (where i.status not in ('DONE', 'CANCELLED')), 0) as remaining_points,
             (pg_catalog.count(*) filter (where i.estimate is null and i.status <> 'CANCELLED'))::integer as unestimated_items
        from items as i
       group by grouping sets ((), (i.assignee_id))
    )
    select case when g.is_total then 'total' else 'assignee' end, g.assignee_id,
           case when g.is_total then null else coalesce(a.full_name, a.email) end,
           g.total_items, g.completed_items, g.remaining_items, g.cancelled_items,
           g.total_points, g.completed_points, g.remaining_points, g.unestimated_items,
           case when g.total_points > 0 then pg_catalog.floor(g.completed_points * 100 / g.total_points)::integer
                when g.total_items > 0 then pg_catalog.floor(g.completed_items * 100.0 / g.total_items)::integer
                else 0 end
      from grouped as g
      left join public.profiles as a on not g.is_total and a.id = g.assignee_id
     order by g.is_total desc, g.remaining_points desc, coalesce(a.full_name, a.email) nulls last;
end;
$$;

-- Daily replay of private.sprint_item_history (UTC days, end of day).
create function private.sprint_burndown(p_sprint_id uuid)
returns table (
  day date, has_data boolean, scope_points numeric, completed_points numeric, remaining_points numeric,
  remaining_items integer, unestimated_items integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_sprint record;
  v_last date;
begin
  perform private.sprint_access(p_sprint_id, false);
  select s.status, s.start_date, s.end_date, s.completed_at into v_sprint from public.sprints as s where s.id = p_sprint_id;
  if v_sprint.status not in ('ACTIVE', 'COMPLETED') or v_sprint.start_date is null or v_sprint.end_date is null then
    return;
  end if;
  -- Never report the future: stop at today (UTC) or at completion.
  v_last := least(v_sprint.end_date, coalesce((v_sprint.completed_at at time zone 'UTC')::date, (pg_catalog.now() at time zone 'UTC')::date));

  return query
    select d.day::date,
           x.has_data,
           case when x.has_data then x.scope_points end,
           case when x.has_data then x.completed_points end,
           case when x.has_data then x.remaining_points end,
           case when x.has_data then x.remaining_items end,
           case when x.has_data then x.unestimated_items end
      from pg_catalog.generate_series(v_sprint.start_date, least(v_last, v_sprint.start_date + 366), interval '1 day') as d(day)
      cross join lateral (
        select exists (
                 select 1 from private.sprint_item_history as h
                  where h.sprint_id = p_sprint_id and h.kind = 'baseline'
                    and h.recorded_at < (d.day::date + 1)::timestamp at time zone 'UTC'
               ) as has_data,
               coalesce(pg_catalog.sum(s.estimate) filter (where s.status <> 'CANCELLED'), 0) as scope_points,
               coalesce(pg_catalog.sum(s.estimate) filter (where s.status = 'DONE'), 0) as completed_points,
               coalesce(pg_catalog.sum(s.estimate) filter (where s.status not in ('DONE', 'CANCELLED')), 0) as remaining_points,
               (pg_catalog.count(*) filter (where s.status not in ('DONE', 'CANCELLED')))::integer as remaining_items,
               (pg_catalog.count(*) filter (where s.estimate is null and s.status not in ('DONE', 'CANCELLED')))::integer as unestimated_items
          from (
            select distinct on (h.work_item_id) h.in_sprint, h.archived, h.status, h.estimate
              from private.sprint_item_history as h
             where h.sprint_id = p_sprint_id
               and h.recorded_at < (d.day::date + 1)::timestamp at time zone 'UTC'
             order by h.work_item_id, h.recorded_at desc, h.id desc
          ) as s
         where s.in_sprint and not s.archived
      ) as x
     order by d.day;
end;
$$;

-- Execution context for the work item page: sprint, blocked reason, latest review decision.
create function private.work_item_execution(p_work_item_id uuid)
returns table (
  sprint_id uuid, sprint_name text, sprint_status public.sprint_status, blocked_reason text,
  last_review_action text, last_review_reason text, last_review_at timestamptz, last_review_by text
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
    select s.id, s.name, s.status, w.blocked_reason, r.action, r.new_values ->> 'reason', r.created_at, coalesce(p.full_name, p.email)
      from public.work_items as w
      left join public.sprints as s on s.id = w.sprint_id
      left join lateral (
        select l.action, l.new_values, l.created_at, l.actor_id from private.project_audit_log as l
         where l.work_item_id = w.id and l.action in ('WORK_ITEM_REVIEW_APPROVED', 'WORK_ITEM_REVIEW_REJECTED')
         order by l.created_at desc, l.id desc limit 1
      ) as r on true
      left join public.profiles as p on p.id = r.actor_id
     where w.id = p_work_item_id;
end;
$$;

-- Activity details: execution events show status and (for block/reject) the reason.
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
          ('Z', 15, 'returned_items'),
          ('E', 5, 'status'), ('E', 16, 'reason')
        ) as f(family, ord, field)
       where f.family = case
               when p_action in ('PROJECT_CREATED', 'PROJECT_UPDATED') then 'P'
               when p_action in ('WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED',
                                 'WORK_ITEM_STATUS_CHANGED', 'WORK_ITEM_PRIORITY_CHANGED') then 'W'
               when p_action in ('WORK_ITEM_STARTED', 'WORK_ITEM_SUBMITTED_FOR_REVIEW', 'WORK_ITEM_REVIEW_APPROVED',
                                 'WORK_ITEM_REVIEW_REJECTED', 'WORK_ITEM_BLOCKED', 'WORK_ITEM_RESUMED') then 'E'
               when p_action in ('SPRINT_CREATED', 'SPRINT_UPDATED') then 'S'
               when p_action = 'SPRINT_CAPACITY_CHANGED' then 'C'
               when p_action = 'SPRINT_COMPLETED' then 'X'
               when p_action = 'SPRINT_CANCELLED' then 'Z'
             end
         and (p_old ? f.field or p_new ? f.field)
         and not (p_action in ('PROJECT_CREATED', 'WORK_ITEM_CREATED', 'SPRINT_CREATED') and (p_new ->> f.field) is null)
    ) as c
$$;

revoke all on function private.execute_work_item(uuid, text, text, public.work_item_status) from public, anon, authenticated, service_role;
revoke all on function private.list_sprint_board(uuid) from public, anon, authenticated, service_role;
revoke all on function private.sprint_progress(uuid) from public, anon, authenticated, service_role;
revoke all on function private.sprint_burndown(uuid) from public, anon, authenticated, service_role;
revoke all on function private.work_item_execution(uuid) from public, anon, authenticated, service_role;
grant execute on function private.execute_work_item(uuid, text, text, public.work_item_status) to authenticated;
grant execute on function private.list_sprint_board(uuid) to authenticated;
grant execute on function private.sprint_progress(uuid) to authenticated;
grant execute on function private.sprint_burndown(uuid) to authenticated;
grant execute on function private.work_item_execution(uuid) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 5. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.execute_work_item(p_work_item_id uuid, p_action text, p_expected_status public.work_item_status, p_reason text default null)
returns table (id uuid, status public.work_item_status, blocked_from_status public.work_item_status,
               blocked_reason text, updated_at timestamptz, changed boolean)
language sql volatile security invoker set search_path = ''
as $$ select * from private.execute_work_item(p_work_item_id, p_action, p_reason, p_expected_status) $$;

create function public.list_sprint_board(p_sprint_id uuid)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text, status public.work_item_status,
  blocked_from_status public.work_item_status, blocked_reason text, priority public.project_priority,
  assignee_id uuid, assignee_name text, estimate numeric, backlog_rank numeric, updated_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_sprint_board(p_sprint_id) $$;

create function public.sprint_progress(p_sprint_id uuid)
returns table (
  scope text, assignee_id uuid, assignee_name text,
  total_items integer, completed_items integer, remaining_items integer, cancelled_items integer,
  total_points numeric, completed_points numeric, remaining_points numeric, unestimated_items integer,
  completion_percent integer
)
language sql stable security invoker set search_path = ''
as $$ select * from private.sprint_progress(p_sprint_id) $$;

create function public.sprint_burndown(p_sprint_id uuid)
returns table (day date, has_data boolean, scope_points numeric, completed_points numeric, remaining_points numeric,
               remaining_items integer, unestimated_items integer)
language sql stable security invoker set search_path = ''
as $$ select * from private.sprint_burndown(p_sprint_id) $$;

create function public.work_item_execution(p_work_item_id uuid)
returns table (sprint_id uuid, sprint_name text, sprint_status public.sprint_status, blocked_reason text,
               last_review_action text, last_review_reason text, last_review_at timestamptz, last_review_by text)
language sql stable security invoker set search_path = ''
as $$ select * from private.work_item_execution(p_work_item_id) $$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.execute_work_item(uuid, text, public.work_item_status, text)',
    'public.list_sprint_board(uuid)',
    'public.sprint_progress(uuid)',
    'public.sprint_burndown(uuid)',
    'public.work_item_execution(uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

comment on function public.execute_work_item(uuid, text, public.work_item_status, text) is
  'Developer execution: start, submit_review, block (reason), resume; manager: approve, reject (reason). Guarded by expected status; retries are no-ops.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   Drop the five public wrappers; with the temporary cyclo_project_api
--   membership drop execute_work_item, list_sprint_board, sprint_progress,
--   sprint_burndown, work_item_execution and re-create change_work_item_status
--   (20261128100000) and project_activity_changes (20261130100000); drop the
--   history triggers/functions and table private.sprint_item_history; restore
--   the 8F1 action check (after deleting the new execution audit rows); drop
--   the blocked_reason constraint/column and index work_items_sprint_status_idx;
--   set manager_only = false for (IN_REVIEW, DONE) and (IN_REVIEW, IN_PROGRESS).
-- =============================================================================
