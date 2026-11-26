-- =============================================================================
-- CYCLO Phase 8E: backlog management (local deployment only)
--
-- Backlog scope
--   Non-archived STORY / TASK / BUG items of a project. Epics are grouping and
--   filter dimensions; subtasks are planned with their task (shown as a count).
--   There is no sprint model yet, so no item is "in a sprint": when sprints
--   arrive, list_backlog gains a "not in a sprint" condition.
--
-- Persistent ordering
--   * work_items.backlog_rank numeric: a position value, never an array index.
--     Moving an item gives it the midpoint between its new neighbours, so only
--     the moved row changes.
--   * Every rank write (insert, move, rebalance) takes a per-project
--     transaction advisory lock, so concurrent moves and inserts are
--     serialized and see each other's results. Ranks are unique per project.
--   * Neighbours are re-read under the lock: the item is placed immediately
--     after its requested predecessor (or before its successor), so a stale
--     client view can never create a duplicate or overlap.
--   * When repeated bisection makes a rank too precise (> 10 decimals), the
--     project's ranks are renumbered to multiples of 1024 in current order.
--   * Reordering never changes status, hierarchy or any other field, and does
--     not bump updated_at.
--
-- Adds
--   * column  work_items.backlog_rank (+ unique per project, backfilled by issue number)
--   * trigger work_items_assign_rank (new items go to the bottom)
--   * RPCs    list_backlog, backlog_summary          (SA · assigned PM · member developers)
--             move_backlog_item, bulk_update_work_items   (SA · assigned PM only)
--   * audit   WORK_ITEM_REORDERED (placement by neighbour keys); bulk changes reuse
--             WORK_ITEM_PRIORITY_CHANGED / WORK_ITEM_ASSIGNED per item
--
-- Changed (same signatures)
--   * work_items_set_updated_at fires only for content/planning columns
--   * list_project_activity resolves neighbour keys for WORK_ITEM_REORDERED
--
-- Error contract additions
--   22023 'invalid_position' | 'invalid_selection' | 'invalid_bulk_change'
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Rank column, backfill and uniqueness
-- -----------------------------------------------------------------------------
alter table public.work_items add column backlog_rank numeric;

update public.work_items as w
   set backlog_rank = r.rank
  from (select id, (row_number() over (partition by project_id order by issue_number)) * 1024 as rank
          from public.work_items) as r
 where r.id = w.id;

alter table public.work_items alter column backlog_rank set not null;
alter table public.work_items add constraint work_items_project_rank_key unique (project_id, backlog_rank);
comment on column public.work_items.backlog_rank is
  'Backlog position (ascending). Midpoint insertion; renumbered only by private.rebalance_backlog. Written under the per-project backlog lock.';

-- Reordering is not a content change.
drop trigger work_items_set_updated_at on public.work_items;
create trigger work_items_set_updated_at
  before update of type, title, description, parent_id, status, blocked_from_status, priority,
                   assignee_id, start_date, due_date, estimate, archived_at
  on public.work_items
  for each row execute function private.set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. Per-project lock and rank assignment for new items (owner postgres)
-- -----------------------------------------------------------------------------
create function private.lock_backlog(p_project_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cyclo.backlog:' || p_project_id::text, 0))
$$;
revoke all on function private.lock_backlog(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lock_backlog(uuid) to cyclo_project_api;

create function private.assign_work_item_rank()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
begin
  perform private.lock_backlog(new.project_id);
  select coalesce(pg_catalog.floor(max(w.backlog_rank)), 0) + 1024 into new.backlog_rank
    from public.work_items as w where w.project_id = new.project_id;
  return new;
end;
$$;
revoke all on function private.assign_work_item_rank() from public, anon, authenticated, service_role;

-- Runs before work_items_guard_row (alphabetical); supplied ranks are ignored.
create trigger work_items_assign_rank
  before insert on public.work_items
  for each row execute function private.assign_work_item_rank();
alter table public.work_items enable always trigger work_items_assign_rank;

grant update (backlog_rank) on table public.work_items to cyclo_project_api;


-- -----------------------------------------------------------------------------
-- 3. Audit action
-- -----------------------------------------------------------------------------
alter table private.project_audit_log drop constraint project_audit_log_action_check;
alter table private.project_audit_log add constraint project_audit_log_action_check check (action in (
  'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_MANAGER_CHANGED',
  'PROJECT_ARCHIVED', 'PROJECT_RESTORED',
  'PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED',
  'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_TYPE_CHANGED', 'WORK_ITEM_PARENT_CHANGED',
  'WORK_ITEM_ASSIGNED', 'WORK_ITEM_PRIORITY_CHANGED', 'WORK_ITEM_STATUS_CHANGED',
  'WORK_ITEM_ARCHIVED', 'WORK_ITEM_RESTORED', 'WORK_ITEM_REORDERED'));


-- -----------------------------------------------------------------------------
-- 4. Implementations (owner cyclo_project_api; same transfer pattern)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Renumbers a project's ranks to 1024, 2048, ... in current order.
-- Two steps keep the unique constraint satisfied row by row. Caller holds the lock.
create function private.rebalance_backlog(p_project_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.work_items as w set backlog_rank = -r.position
    from (select id, row_number() over (order by backlog_rank, issue_number) as position
            from public.work_items where project_id = p_project_id) as r
   where w.id = r.id;
  update public.work_items as w set backlog_rank = -w.backlog_rank * 1024
   where w.project_id = p_project_id;
$$;

-- Items shown in a backlog (shared by list and summary).
create function private.backlog_items(p_project_id uuid, p_include_completed boolean)
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
     and w.type in ('STORY', 'TASK', 'BUG')
     and (p_include_completed or w.status not in ('DONE', 'CANCELLED'))
$$;

create function private.list_backlog(
  p_project_id uuid,
  p_search text,
  p_type public.work_item_type,
  p_status public.work_item_status,
  p_priority public.project_priority,
  p_assignee_id uuid,
  p_unassigned boolean,
  p_epic_id uuid,
  p_no_epic boolean,
  p_include_completed boolean,
  p_group text,
  p_page integer,
  p_page_size integer
)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  assignee_id uuid, assignee_name text, estimate numeric, backlog_rank numeric,
  epic_id uuid, epic_key text, epic_title text, subtask_count integer,
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
  if p_unassigned is null or p_no_epic is null or p_include_completed is null then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_type is not null and p_type not in ('STORY', 'TASK', 'BUG') then
    raise exception using errcode = '22023', message = 'invalid_type';
  end if;
  if p_group is null or p_group not in ('none', 'epic', 'type', 'priority', 'status') then
    raise exception using errcode = '22023', message = 'invalid_group';
  end if;
  if v_search is not null then
    if pg_catalog.char_length(v_search) > 100 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_search ~ '^([A-Za-z][A-Za-z0-9]{1,9}-)?[0-9]{1,9}$' then
      v_number := pg_catalog.substring(v_search, '([0-9]+)$')::integer;
      v_exact_key := pg_catalog.strpos(v_search, '-') > 0;
    end if;
  end if;

  return query
    select b.id, b.issue_key, b.type, b.title, b.status, b.priority,
           b.assignee_id, coalesce(assignee.full_name, assignee.email), b.estimate, b.backlog_rank,
           b.epic_id, epic.issue_key, epic.title,
           (select pg_catalog.count(*)::integer from public.work_items as s
             where s.parent_id = b.id and s.type = 'SUBTASK' and s.archived_at is null),
           pg_catalog.count(*) over ()
      from private.backlog_items(p_project_id, p_include_completed) as b
      left join public.work_items as epic on epic.id = b.epic_id
      left join public.profiles as assignee on assignee.id = b.assignee_id
     where (p_type is null or b.type = p_type)
       and (p_status is null or b.status = p_status)
       and (p_priority is null or b.priority = p_priority)
       and (p_assignee_id is null or b.assignee_id = p_assignee_id)
       and (not p_unassigned or b.assignee_id is null)
       and (p_epic_id is null or b.epic_id = p_epic_id)
       and (not p_no_epic or b.epic_id is null)
       and (v_pattern is null
            or (v_exact_key and pg_catalog.upper(v_search) = b.issue_key)
            or (not v_exact_key and v_number is not null
                and (b.issue_number = v_number or b.title operator(pg_catalog.~~*) v_pattern))
            or (v_number is null
                and (b.title operator(pg_catalog.~~*) v_pattern or b.issue_key operator(pg_catalog.~~*) v_pattern)))
     order by
       -- Grouped views keep each group contiguous across pages; rank orders within a group.
       case when p_group = 'epic'     then epic.backlog_rank end asc nulls last,
       case when p_group = 'type'     then b.type end asc,
       case when p_group = 'priority' then b.priority end desc,
       case when p_group = 'status'   then b.status end asc,
       b.backlog_rank asc,
       b.issue_number asc
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;

-- Counts for the backlog header and filter options (one pass over open items).
create function private.backlog_summary(p_project_id uuid)
returns table (dimension text, key text, label text, item_count integer, estimate_total numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.work_item_access(p_project_id);

  return query
    with items as (select * from private.backlog_items(p_project_id, false))
    select 'total', 'all', null::text, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i
    union all
    select 'status', i.status::text, null, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i group by i.status
    union all
    select 'type', i.type::text, null, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i group by i.type
    union all
    select 'priority', i.priority::text, null, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i group by i.priority
    union all
    select 'assignee', 'unassigned', null, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i where i.assignee_id is null
    union all
    select 'estimate', 'unestimated', null, pg_catalog.count(*)::integer, null from items as i where i.estimate is null
    union all
    -- Every non-archived epic (also empty ones, for the filter), in backlog order.
    select 'epic', e.id::text, e.issue_key || ' · ' || e.title,
           (select pg_catalog.count(*)::integer from items as i where i.epic_id = e.id),
           (select pg_catalog.sum(i.estimate) from items as i where i.epic_id = e.id)
      from (select w.id, w.issue_key, w.title from public.work_items as w
             where w.project_id = p_project_id and w.type = 'EPIC' and w.archived_at is null
             order by w.backlog_rank limit 200) as e
    union all
    select 'epic', 'none', null, pg_catalog.count(*)::integer, pg_catalog.sum(i.estimate) from items as i where i.epic_id is null;
end;
$$;

-- Places an item immediately after p_after_id (or, when null, immediately
-- before p_before_id). Neighbours are re-read under the backlog lock.
create function private.move_backlog_item(p_work_item_id uuid, p_after_id uuid, p_before_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lock record;
  v_anchor uuid := coalesce(p_after_id, p_before_id);
  v_anchor_rank numeric;
  v_current numeric;
  v_low numeric;
  v_high numeric;
  v_new numeric;
  v_after_key text;
  v_before_key text;
begin
  select * into v_lock from private.lock_work_item(p_work_item_id, false);
  if not v_lock.is_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if v_anchor is null or v_anchor = p_work_item_id or p_before_id = p_work_item_id then
    raise exception using errcode = '22023', message = 'invalid_position';
  end if;

  perform private.lock_backlog(v_lock.project_id);

  for attempt in 1..2 loop
    select w.backlog_rank into v_anchor_rank from public.work_items as w
     where w.id = v_anchor and w.project_id = v_lock.project_id and w.archived_at is null;
    if not found then
      raise exception using errcode = '22023', message = 'invalid_position';
    end if;
    select w.backlog_rank into v_current from public.work_items as w where w.id = p_work_item_id;

    if p_after_id is not null then
      v_low := v_anchor_rank;
      select min(w.backlog_rank) into v_high from public.work_items as w
       where w.project_id = v_lock.project_id and w.backlog_rank > v_low and w.id <> p_work_item_id;
      v_new := case when v_high is null then pg_catalog.floor(v_low) + 1024
                    else pg_catalog.trim_scale((v_low + v_high) / 2) end;
    else
      v_high := v_anchor_rank;
      select max(w.backlog_rank) into v_low from public.work_items as w
       where w.project_id = v_lock.project_id and w.backlog_rank < v_high and w.id <> p_work_item_id;
      v_new := case when v_low is null then pg_catalog.ceil(v_high) - 1024
                    else pg_catalog.trim_scale((v_low + v_high) / 2) end;
    end if;

    exit when pg_catalog.scale(v_new) <= 10;
    perform private.rebalance_backlog(v_lock.project_id);
  end loop;

  -- Already in place: nothing to change or record.
  if (v_low is null or v_current > v_low) and (v_high is null or v_current < v_high) then
    return p_work_item_id;
  end if;

  update public.work_items as w set backlog_rank = v_new where w.id = p_work_item_id;

  -- Record placement relative to the nearest items a backlog actually shows.
  select w.issue_key into v_after_key from public.work_items as w
   where w.project_id = v_lock.project_id and w.backlog_rank < v_new and w.archived_at is null
     and w.type in ('STORY', 'TASK', 'BUG')
   order by w.backlog_rank desc limit 1;
  select w.issue_key into v_before_key from public.work_items as w
   where w.project_id = v_lock.project_id and w.backlog_rank > v_new and w.archived_at is null
     and w.type in ('STORY', 'TASK', 'BUG')
   order by w.backlog_rank asc limit 1;
  perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, p_work_item_id, 'WORK_ITEM_REORDERED',
    '{}'::jsonb, pg_catalog.jsonb_build_object('after_key', v_after_key, 'before_key', v_before_key));
  return p_work_item_id;
end;
$$;

-- Bulk planning: priority and/or assignee for up to 100 items, all or nothing.
-- Each item goes through the single-item RPC (same checks and audit).
create function private.bulk_update_work_items(
  p_project_id uuid,
  p_work_item_ids uuid[],
  p_change_priority boolean,
  p_priority public.project_priority,
  p_change_assignee boolean,
  p_assignee_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_manager boolean;
  v_count integer;
  v_id uuid;
begin
  select a.is_manager into v_manager from private.work_item_access(p_project_id) as a;
  if not v_manager then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_change_priority is null or p_change_assignee is null
     or not (p_change_priority or p_change_assignee)
     or (p_change_priority and p_priority is null) then
    raise exception using errcode = '22023', message = 'invalid_bulk_change';
  end if;

  v_count := coalesce(pg_catalog.cardinality(p_work_item_ids), 0);
  if v_count < 1 or v_count > 100
     or (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_work_item_ids) as x) <> v_count
     or exists (select 1 from pg_catalog.unnest(p_work_item_ids) as x where x is null)
     or (select pg_catalog.count(*) from public.work_items as w
          where w.id = any (p_work_item_ids) and w.project_id = p_project_id and w.archived_at is null) <> v_count then
    raise exception using errcode = '22023', message = 'invalid_selection';
  end if;

  -- Fixed lock order across concurrent bulk updates.
  for v_id in select x from pg_catalog.unnest(p_work_item_ids) as x order by x loop
    if p_change_priority then
      perform private.change_work_item_priority(v_id, p_priority);
    end if;
    if p_change_assignee then
      perform private.assign_work_item(v_id, p_assignee_id);
    end if;
  end loop;
  return v_count;
end;
$$;

-- Phase 8C/8D activity with placement keys for WORK_ITEM_REORDERED (same signature).
create or replace function private.list_project_activity(
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
             -- Issue keys are immutable, display-safe values recorded at move time.
             when l.action = 'WORK_ITEM_REORDERED' then l.new_values ->> 'before_key'
           end,
           case
             when l.action in ('PROJECT_MANAGER_CHANGED', 'WORK_ITEM_ASSIGNED')
               then coalesce(old_person.full_name, old_person.email)
             when l.action = 'WORK_ITEM_PARENT_CHANGED' then old_parent.issue_key
             when l.action = 'WORK_ITEM_REORDERED' then l.new_values ->> 'after_key'
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

revoke all on function private.rebalance_backlog(uuid) from public, anon, authenticated, service_role;
revoke all on function private.backlog_items(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.list_backlog(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, uuid, boolean, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.backlog_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function private.move_backlog_item(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.bulk_update_work_items(uuid, uuid[], boolean, public.project_priority, boolean, uuid) from public, anon, authenticated, service_role;

grant execute on function private.list_backlog(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, uuid, boolean, boolean, text, integer, integer) to authenticated;
grant execute on function private.backlog_summary(uuid) to authenticated;
grant execute on function private.move_backlog_item(uuid, uuid, uuid) to authenticated;
grant execute on function private.bulk_update_work_items(uuid, uuid[], boolean, public.project_priority, boolean, uuid) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 5. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_backlog(
  p_project_id uuid,
  p_search text default null,
  p_type public.work_item_type default null,
  p_status public.work_item_status default null,
  p_priority public.project_priority default null,
  p_assignee_id uuid default null,
  p_unassigned boolean default false,
  p_epic_id uuid default null,
  p_no_epic boolean default false,
  p_include_completed boolean default false,
  p_group text default 'none',
  p_page integer default 1,
  p_page_size integer default 50
)
returns table (
  id uuid, issue_key text, type public.work_item_type, title text,
  status public.work_item_status, priority public.project_priority,
  assignee_id uuid, assignee_name text, estimate numeric, backlog_rank numeric,
  epic_id uuid, epic_key text, epic_title text, subtask_count integer, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  select l.id, l.issue_key, l.type, l.title, l.status, l.priority, l.assignee_id, l.assignee_name,
         l.estimate, l.backlog_rank, l.epic_id, l.epic_key, l.epic_title, l.subtask_count, l.total_count
    from private.list_backlog(p_project_id, p_search, p_type, p_status, p_priority, p_assignee_id, p_unassigned,
                              p_epic_id, p_no_epic, p_include_completed, p_group, p_page, p_page_size) as l
$$;

create function public.backlog_summary(p_project_id uuid)
returns table (dimension text, key text, label text, item_count integer, estimate_total numeric)
language sql stable security invoker set search_path = ''
as $$
  select s.dimension, s.key, s.label, s.item_count, s.estimate_total from private.backlog_summary(p_project_id) as s
$$;

create function public.move_backlog_item(p_work_item_id uuid, p_after_id uuid default null, p_before_id uuid default null)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.move_backlog_item(p_work_item_id, p_after_id, p_before_id) $$;

create function public.bulk_update_work_items(
  p_project_id uuid,
  p_work_item_ids uuid[],
  p_change_priority boolean default false,
  p_priority public.project_priority default null,
  p_change_assignee boolean default false,
  p_assignee_id uuid default null
)
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.bulk_update_work_items(p_project_id, p_work_item_ids, p_change_priority, p_priority, p_change_assignee, p_assignee_id) $$;

revoke all on function public.list_backlog(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, uuid, boolean, boolean, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.backlog_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public.move_backlog_item(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.bulk_update_work_items(uuid, uuid[], boolean, public.project_priority, boolean, uuid) from public, anon, authenticated, service_role;

grant execute on function public.list_backlog(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, uuid, boolean, boolean, text, integer, integer) to authenticated;
grant execute on function public.backlog_summary(uuid) to authenticated;
grant execute on function public.move_backlog_item(uuid, uuid, uuid) to authenticated;
grant execute on function public.bulk_update_work_items(uuid, uuid[], boolean, public.project_priority, boolean, uuid) to authenticated;

comment on function public.list_backlog(uuid, text, public.work_item_type, public.work_item_status, public.project_priority, uuid, boolean, uuid, boolean, boolean, text, integer, integer) is
  'Backlog page in rank order (optionally grouped). SA, assigned PM or member developer.';
comment on function public.move_backlog_item(uuid, uuid, uuid) is
  'Place an item right after p_after_id (or before p_before_id). SA or assigned PM. Never changes status.';
comment on function public.bulk_update_work_items(uuid, uuid[], boolean, public.project_priority, boolean, uuid) is
  'Set priority and/or assignee for up to 100 items atomically. SA or assigned PM.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   drop the four public wrappers; with the temporary cyclo_project_api
--   membership drop private.bulk_update_work_items, move_backlog_item,
--   backlog_summary, list_backlog, backlog_items, rebalance_backlog and re-create
--   list_project_activity from 20261128100000; drop trigger work_items_assign_rank,
--   functions assign_work_item_rank and lock_backlog; restore the unconditional
--   work_items_set_updated_at trigger; delete WORK_ITEM_REORDERED audit rows and
--   restore the 8D action check; drop column work_items.backlog_rank.
-- =============================================================================
