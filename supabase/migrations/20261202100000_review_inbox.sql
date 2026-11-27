-- =============================================================================
-- CYCLO Phase 8G1: Review Inbox (local deployment only)
--
-- A cross-project queue of work awaiting review, derived from existing state.
-- No new tables; decisions still go through execute_work_item (8F2), which
-- re-checks the manager rule, the expected status and records the audit event.
--
-- Scope (decided here, never by the client):
--   SUPER_ADMIN       every non-archived project
--   PROJECT_MANAGER   non-archived projects where projects.project_manager_id = caller
--   DEVELOPER         refused (42501 forbidden), as are inactive/unknown callers
-- Archived projects and archived items are excluded: they are read-only, so a
-- review there could not be decided anyway.
--
-- Submitted at: the latest audit event that put the item into review
--   (WORK_ITEM_SUBMITTED_FOR_REVIEW, or a pre-8F2 generic WORK_ITEM_STATUS_CHANGED
--   to IN_REVIEW); falls back to work_items.updated_at when no event exists.
--   Resuming a review that was blocked keeps the original submission time, so
--   time spent blocked still counts as waiting.
--
-- Read API (SECURITY INVOKER public wrappers over SECURITY DEFINER private
-- implementations owned by cyclo_project_api, as in earlier phases):
--   list_review_queue(search, project, assignee, unassigned, priority,
--                     min_age_days, sort, page, page_size)
--     Paginated (offset, max 100 per page), stable order: the sort key, then
--     issue key, then id. Default sort 'oldest' (oldest submission first).
--   review_queue_summary()
--     Unfiltered pending counts per project and per assignee (facets + totals).
-- Assignee names are full_name only (no email or other profile fields).
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Indexes
-- -----------------------------------------------------------------------------
-- The queue scans only in-review, non-archived work (small, hot subset).
create index work_items_in_review_idx on public.work_items (project_id, assignee_id)
  where status = 'IN_REVIEW' and archived_at is null;

-- Latest "entered review" event per item.
create index project_audit_log_submitted_idx on private.project_audit_log (work_item_id, created_at desc, id desc)
  where action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW'
     or (action = 'WORK_ITEM_STATUS_CHANGED' and (new_values ->> 'status') = 'IN_REVIEW');


-- -----------------------------------------------------------------------------
-- 2. Implementations (owner cyclo_project_api; same transfer pattern as 8D-8F2)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- The caller may use the review inbox: active Super Admin or Project Manager.
create function private.review_actor(out actor_id uuid, out is_super_admin boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  select a.actor_id, a.actor_role into actor_id, v_role from private.project_actor() as a;
  if v_role is null or v_role not in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  is_super_admin := v_role = 'SUPER_ADMIN'::public.app_role;
end;
$$;

create function private.list_review_queue(
  p_search text,
  p_project_id uuid,
  p_assignee_id uuid,
  p_unassigned boolean,
  p_priority public.project_priority,
  p_min_age_days integer,
  p_sort text,
  p_page integer,
  p_page_size integer
)
returns table (
  id uuid, issue_key text, issue_number integer, type public.work_item_type, title text,
  priority public.project_priority,
  project_id uuid, project_name text, project_key text,
  assignee_id uuid, assignee_name text,
  submitted_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor record;
  v_search text := nullif(private.trim_text(p_search), '');
  v_pattern text;
  v_number integer;
  v_exact_key boolean := false;
  v_cutoff timestamptz;
begin
  select * into v_actor from private.review_actor();

  if p_page is null or p_page < 1 or p_page > 100000 then
    raise exception using errcode = '22023', message = 'invalid_page';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;
  if p_unassigned is null or (p_unassigned and p_assignee_id is not null) then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_min_age_days is not null and (p_min_age_days < 0 or p_min_age_days > 365) then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_sort is null or p_sort not in ('oldest', 'newest', 'priority') then
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
  if p_min_age_days is not null then
    v_cutoff := pg_catalog.now() - pg_catalog.make_interval(days => p_min_age_days);
  end if;

  return query
    with pending as (
      select w.id, w.issue_key, w.issue_number, w.type, w.title, w.priority,
             pr.id as project_id, pr.name as project_name, pr.project_key,
             w.assignee_id, assignee.full_name as assignee_name,
             coalesce(entered.created_at, w.updated_at) as submitted_at
        from public.work_items as w
        join public.projects as pr on pr.id = w.project_id
        left join public.profiles as assignee on assignee.id = w.assignee_id
        left join lateral (
          select l.created_at from private.project_audit_log as l
           where l.work_item_id = w.id
             and (l.action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW'
                  or (l.action = 'WORK_ITEM_STATUS_CHANGED' and (l.new_values ->> 'status') = 'IN_REVIEW'))
           order by l.created_at desc, l.id desc
           limit 1
        ) as entered on true
       where w.status = 'IN_REVIEW'
         and w.archived_at is null
         and pr.archived_at is null
         and (v_actor.is_super_admin or pr.project_manager_id = v_actor.actor_id)
         and (p_project_id is null or w.project_id = p_project_id)
         and (p_priority is null or w.priority = p_priority)
         and (p_assignee_id is null or w.assignee_id = p_assignee_id)
         and (not p_unassigned or w.assignee_id is null)
         and (v_pattern is null
              or (v_exact_key and pg_catalog.upper(v_search) = w.issue_key)
              or (not v_exact_key and v_number is not null
                  and (w.issue_number = v_number or w.title operator(pg_catalog.~~*) v_pattern))
              or (v_number is null
                  and (w.title operator(pg_catalog.~~*) v_pattern or w.issue_key operator(pg_catalog.~~*) v_pattern)))
    )
    select q.id, q.issue_key, q.issue_number, q.type, q.title, q.priority,
           q.project_id, q.project_name, q.project_key,
           q.assignee_id, q.assignee_name, q.submitted_at,
           pg_catalog.count(*) over ()
      from pending as q
     where v_cutoff is null or q.submitted_at <= v_cutoff
     order by
       case when p_sort = 'priority' then q.priority end desc,
       case when p_sort = 'newest' then q.submitted_at end desc,
       case when p_sort <> 'newest' then q.submitted_at end asc,
       q.project_key asc,
       q.issue_number asc,
       q.id asc
     limit p_page_size
    offset (p_page - 1) * p_page_size;
end;
$$;

-- Unfiltered pending counts: one row per project and one per assignee
-- (assignee_id null = unassigned). Totals are the sum of the project rows.
create function private.review_queue_summary()
returns table (
  scope text, id uuid, label text, project_key text, pending_count integer, oldest_submitted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor record;
begin
  select * into v_actor from private.review_actor();

  return query
    with pending as (
      select w.id, pr.id as project_id, pr.name as project_name, pr.project_key,
             w.assignee_id, assignee.full_name as assignee_name,
             coalesce(entered.created_at, w.updated_at) as submitted_at
        from public.work_items as w
        join public.projects as pr on pr.id = w.project_id
        left join public.profiles as assignee on assignee.id = w.assignee_id
        left join lateral (
          select l.created_at from private.project_audit_log as l
           where l.work_item_id = w.id
             and (l.action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW'
                  or (l.action = 'WORK_ITEM_STATUS_CHANGED' and (l.new_values ->> 'status') = 'IN_REVIEW'))
           order by l.created_at desc, l.id desc
           limit 1
        ) as entered on true
       where w.status = 'IN_REVIEW'
         and w.archived_at is null
         and pr.archived_at is null
         and (v_actor.is_super_admin or pr.project_manager_id = v_actor.actor_id)
    )
    select 'project'::text, p.project_id, pg_catalog.min(p.project_name), pg_catalog.min(p.project_key),
           pg_catalog.count(*)::integer, pg_catalog.min(p.submitted_at)
      from pending as p
     group by p.project_id
    union all
    select 'assignee'::text, p.assignee_id, pg_catalog.min(p.assignee_name), null::text,
           pg_catalog.count(*)::integer, pg_catalog.min(p.submitted_at)
      from pending as p
     group by p.assignee_id
     order by 1 desc, 6 asc, 3 asc nulls last;
end;
$$;

revoke all on function private.review_actor() from public, anon, authenticated, service_role;
revoke all on function private.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.review_queue_summary() from public, anon, authenticated, service_role;
grant execute on function private.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer) to authenticated;
grant execute on function private.review_queue_summary() to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 3. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_review_queue(
  p_search text default null,
  p_project_id uuid default null,
  p_assignee_id uuid default null,
  p_unassigned boolean default false,
  p_priority public.project_priority default null,
  p_min_age_days integer default null,
  p_sort text default 'oldest',
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  id uuid, issue_key text, issue_number integer, type public.work_item_type, title text,
  priority public.project_priority,
  project_id uuid, project_name text, project_key text,
  assignee_id uuid, assignee_name text,
  submitted_at timestamptz,
  total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  select * from private.list_review_queue(p_search, p_project_id, p_assignee_id, p_unassigned, p_priority,
                                          p_min_age_days, p_sort, p_page, p_page_size)
$$;

create function public.review_queue_summary()
returns table (scope text, id uuid, label text, project_key text, pending_count integer, oldest_submitted_at timestamptz)
language sql stable security invoker set search_path = ''
as $$ select * from private.review_queue_summary() $$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer)',
    'public.review_queue_summary()'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

comment on function public.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer) is
  'Review inbox (SA: all projects; PM: assigned projects). IN_REVIEW, non-archived work only; oldest submission first by default.';
comment on function public.review_queue_summary() is
  'Pending review counts per project and per assignee for the caller''s review scope.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   drop function public.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer);
--   drop function public.review_queue_summary();
--   drop function private.list_review_queue(text, uuid, uuid, boolean, public.project_priority, integer, text, integer, integer);
--   drop function private.review_queue_summary();
--   drop function private.review_actor();
--   drop index public.work_items_in_review_idx;
--   drop index private.project_audit_log_submitted_idx;
-- =============================================================================
