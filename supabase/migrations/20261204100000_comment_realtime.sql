-- =============================================================================
-- CYCLO Phase 8G2 (Realtime): live discussion updates (local deployment only)
--
-- 1. public.work_item_comments joins the supabase_realtime publication, so
--    Supabase Realtime (Postgres Changes) can stream its changes. Realtime
--    checks each change against the table's existing SELECT policies using the
--    subscriber's own JWT (Super Admin: all; assigned PM; member developer), so
--    other projects' discussions are never delivered. Mentions are NOT
--    published. Comments are never hard-deleted (trigger), so the one event
--    type that bypasses RLS (DELETE) carries nothing in practice; the client
--    uses event ids only and never renders payload content.
--
-- 2. get_work_item_comments(item, ids): the event payload is a signal only.
--    The client re-reads the changed rows (with author names and mentions)
--    through this RPC, which applies the same read access as the list RPCs and
--    returns only rows of that work item. At most 50 ids per call.
-- =============================================================================
begin;

alter publication supabase_realtime add table public.work_item_comments;

grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

create function private.get_work_item_comments(p_work_item_id uuid, p_ids uuid[])
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
begin
  perform private.comment_read_access(p_work_item_id);
  if p_ids is null or pg_catalog.cardinality(p_ids) > 50 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  select pg_catalog.array_agg(c.id order by c.created_at, c.id) into v_ids
    from public.work_item_comments as c
   where c.id = any (p_ids) and c.work_item_id = p_work_item_id;
  return query select * from private.comment_details(coalesce(v_ids, '{}'));
end;
$$;

revoke all on function private.get_work_item_comments(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function private.get_work_item_comments(uuid, uuid[]) to authenticated;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;

create function public.get_work_item_comments(p_work_item_id uuid, p_ids uuid[])
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql stable security invoker set search_path = ''
as $$ select * from private.get_work_item_comments(p_work_item_id, p_ids) $$;

revoke all on function public.get_work_item_comments(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_work_item_comments(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   alter publication supabase_realtime drop table public.work_item_comments;
--   drop function public.get_work_item_comments(uuid, uuid[]);
--   drop function private.get_work_item_comments(uuid, uuid[]);  -- with the temporary cyclo_project_api membership
-- =============================================================================
