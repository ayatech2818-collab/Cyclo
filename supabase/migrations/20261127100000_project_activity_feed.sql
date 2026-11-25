-- =============================================================================
-- CYCLO Phase 8C: project activity feed (read-only; local deployment only)
--
-- Reuses private.project_audit_log (Phases 8A/8B). No new event tracking and
-- no new audit table. Existing writers (unchanged): create_project,
-- update_project, assign_project_manager, set_project_archived,
-- add_project_member, remove_project_member.
--
-- Recorded events and the fields this feed exposes:
--   PROJECT_CREATED          name, project_key, status, priority, start_date, target_date,
--                            description (presence only)
--   PROJECT_UPDATED          changed fields among name, status, priority, start_date,
--                            target_date; description as "changed" without its text
--   PROJECT_MANAGER_CHANGED  previous and new PM names (ids resolved, never returned raw)
--   PROJECT_ARCHIVED / PROJECT_RESTORED   (no fields)
--   PROJECT_MEMBER_ADDED / PROJECT_MEMBER_REMOVED   member name
--
-- Adds:
--   * SELECT on private.project_audit_log for cyclo_project_api (+ policy)
--   * SELECT (avatar_kind, avatar_symbol) on profiles for cyclo_project_api
--   * private.list_project_activity(...) SECURITY DEFINER, owner cyclo_project_api
--   * public.list_project_activity(...)  SECURITY INVOKER wrapper (authenticated)
--
-- Access: private.require_project_team_reader (Phase 8B): SA, the assigned PM,
-- or a member developer; P0002 'project_not_found' otherwise. Employees still
-- have no privilege on the audit table itself.
--
-- Pagination: keyset cursor (created_at, id), newest first. Pass the last row's
-- created_at and id to fetch the next page; both or neither.
--
-- Not exposed: raw old_values/new_values, profile ids inside them, description
-- text, archived_at values, actor emails beyond the existing name fallback,
-- administrator avatar URLs and storage paths.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Read access for the RPC owner only
-- -----------------------------------------------------------------------------
grant select on private.project_audit_log to cyclo_project_api;
create policy project_api_read_audit on private.project_audit_log
  for select to cyclo_project_api using (true);

-- Avatar choice (allow-listed emoji/icon ids) for actor display. Not avatar_url
-- or avatar_path: photos are resolved by the existing avatar RPC and Storage RLS.
grant select (avatar_kind, avatar_symbol) on table public.profiles to cyclo_project_api;


-- -----------------------------------------------------------------------------
-- 2. Implementation (owner cyclo_project_api; same transfer pattern as 8A/8B)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Allow-listed, display-safe change list for one audit row:
-- [{ "field": "...", "from": <json|null>, "to": <json|null> }, ...]
create function private.project_activity_changes(p_action text, p_old jsonb, p_new jsonb)
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
               when f.field = 'description' then
                 -- Presence/changed only: description text is never returned.
                 pg_catalog.jsonb_build_object('field', 'description')
               else
                 pg_catalog.jsonb_build_object('field', f.field, 'from', p_old -> f.field, 'to', p_new -> f.field)
             end as item
        from (values (1, 'name'), (2, 'project_key'), (3, 'status'), (4, 'priority'),
                     (5, 'start_date'), (6, 'target_date'), (7, 'description')) as f(ord, field)
       where p_action in ('PROJECT_CREATED', 'PROJECT_UPDATED')
         and (p_old ? f.field or p_new ? f.field)
         -- A creation without a description has nothing to show for it.
         and not (p_action = 'PROJECT_CREATED' and f.field = 'description'
                  and pg_catalog.jsonb_typeof(p_new -> 'description') is distinct from 'string')
         and not (p_action = 'PROJECT_CREATED'
                  and pg_catalog.jsonb_typeof(p_new -> f.field) is distinct from 'string')
    ) as c
$$;

create function private.list_project_activity(
  p_project_id uuid,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer
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
  changes jsonb
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
             when l.action in ('PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED')
               then coalesce(member.full_name, member.email)
             when l.action = 'PROJECT_MANAGER_CHANGED'
               then coalesce(new_pm.full_name, new_pm.email)
           end,
           case
             when l.action = 'PROJECT_MANAGER_CHANGED'
               then coalesce(old_pm.full_name, old_pm.email)
           end,
           private.project_activity_changes(l.action, l.old_values, l.new_values)
      from private.project_audit_log as l
      left join public.profiles as actor  on actor.id = l.actor_id
      left join public.profiles as member on member.id = (case
             when l.action = 'PROJECT_MEMBER_ADDED'   then l.new_values ->> 'profile_id'
             when l.action = 'PROJECT_MEMBER_REMOVED' then l.old_values ->> 'profile_id'
           end)::uuid
      left join public.profiles as new_pm on l.action = 'PROJECT_MANAGER_CHANGED'
                                         and new_pm.id = (l.new_values ->> 'project_manager_id')::uuid
      left join public.profiles as old_pm on l.action = 'PROJECT_MANAGER_CHANGED'
                                         and old_pm.id = (l.old_values ->> 'project_manager_id')::uuid
     where l.project_id = p_project_id
       and (p_before_created_at is null
            or (l.created_at, l.id) < (p_before_created_at, p_before_id))
     order by l.created_at desc, l.id desc
     limit p_limit;
end;
$$;

revoke all on function private.project_activity_changes(text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.list_project_activity(uuid, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function private.list_project_activity(uuid, timestamptz, uuid, integer) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 3. Public wrapper
-- -----------------------------------------------------------------------------
create function public.list_project_activity(
  p_project_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns table (
  id uuid, action text, created_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  subject_name text, previous_subject_name text, changes jsonb
)
language sql stable security invoker set search_path = ''
as $$
  select a.id, a.action, a.created_at, a.actor_id, a.actor_name, a.actor_avatar_kind,
         a.actor_avatar_symbol, a.subject_name, a.previous_subject_name, a.changes
    from private.list_project_activity(p_project_id, p_before_created_at, p_before_id, p_limit) as a
$$;

revoke all on function public.list_project_activity(uuid, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_project_activity(uuid, timestamptz, uuid, integer) to authenticated;

comment on function public.list_project_activity(uuid, timestamptz, uuid, integer) is
  'Project activity, newest first, keyset-paginated by (created_at, id). SA, assigned PM or member developer.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres). Audit data is not touched.
--
-- drop function if exists public.list_project_activity(uuid, timestamptz, uuid, integer);
-- grant cyclo_project_api to postgres with inherit false, set true;
-- drop function if exists private.list_project_activity(uuid, timestamptz, uuid, integer);
-- drop function if exists private.project_activity_changes(text, jsonb, jsonb);
-- revoke cyclo_project_api from postgres;
-- revoke select (avatar_kind, avatar_symbol) on table public.profiles from cyclo_project_api;
-- drop policy if exists project_api_read_audit on private.project_audit_log;
-- revoke select on private.project_audit_log from cyclo_project_api;
-- =============================================================================
