-- =============================================================================
-- CYCLO Phase 8G2: work item comments, one-level replies and @mentions
-- (local deployment only)
--
-- Tables (owner postgres; written only through the RPCs below):
--   public.work_item_comments
--     One table for comments and replies. parent_comment_id is null for a
--     top-level comment and points at a top-level comment of the SAME work item
--     for a reply (composite foreign key + trigger: one level only).
--     (project_id, work_item_id) references work_items (project_id, id), so a
--     comment can never be attached across projects.
--     Soft delete: body becomes null and deleted_at is set, so replies keep
--     their thread. Rows are never hard-deleted.
--   public.work_item_comment_mentions
--     (comment_id, profile_id) primary key: one row per person per comment,
--     however often they are mentioned. Kept in sync on edit (rows for people
--     still mentioned keep their created_at, so a future notifier can tell new
--     mentions from old ones).
--
-- Body format: plain text (multiline), 1-5000 characters after trimming, no
-- control characters other than newline and tab. A mention is the token
-- <@profile-uuid>; the database extracts the tokens, de-duplicates them and
-- refuses any id that is not an active employee with access to the project
-- (Super Admins, the assigned PM, member developers). At most 20 people per
-- comment.
--
-- Access (decided here; ids, roles and authors never come from the client):
--   read / comment / reply / search mentions: anyone who can read the project
--     (SA, assigned PM, member developer); archived projects and archived
--     work items are read-only.
--   edit / delete: the author only, while they can still access the project.
--
-- Audit: WORK_ITEM_COMMENT_ADDED / _EDITED / _DELETED in the existing project
-- audit log with {comment_id, reply, mentions}; never the comment text.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table public.work_item_comments (
  id                uuid        primary key default gen_random_uuid(),
  project_id        uuid        not null,
  work_item_id      uuid        not null,
  parent_comment_id uuid,
  author_id         uuid        not null references public.profiles (id) on delete restrict,
  body              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,

  constraint work_item_comments_item_fkey foreign key (project_id, work_item_id)
    references public.work_items (project_id, id) on delete restrict,
  -- Target of the same-work-item reply foreign key.
  constraint work_item_comments_item_id_key unique (work_item_id, id),
  constraint work_item_comments_parent_same_item_fkey foreign key (work_item_id, parent_comment_id)
    references public.work_item_comments (work_item_id, id) on delete restrict,
  constraint work_item_comments_not_own_parent check (parent_comment_id is null or parent_comment_id <> id),
  constraint work_item_comments_body_state check (
    case when deleted_at is null
      then body is not null
           and char_length(body) between 1 and 5000
           and body = btrim(body, E' \n\t')
           and body !~ '[\x01-\x08\x0b-\x1f\x7f\r]'
      else body is null
    end
  ),
  constraint work_item_comments_edited_after_created check (edited_at is null or edited_at >= created_at)
);

comment on table public.work_item_comments is
  'Work item discussion: comments and one-level replies. Writes only through comment RPCs; soft-deleted, never removed.';
comment on column public.work_item_comments.body is
  'Plain text; mentions are <@profile-uuid> tokens mirrored in work_item_comment_mentions. Null once deleted.';

create index work_item_comments_thread_idx on public.work_item_comments (work_item_id, created_at, id)
  where parent_comment_id is null;
create index work_item_comments_replies_idx on public.work_item_comments (parent_comment_id, created_at, id)
  where parent_comment_id is not null;
create index work_item_comments_author_idx on public.work_item_comments (author_id);
create index work_item_comments_project_idx on public.work_item_comments (project_id);

create table public.work_item_comment_mentions (
  comment_id uuid        not null references public.work_item_comments (id) on delete cascade,
  profile_id uuid        not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (comment_id, profile_id)
);
comment on table public.work_item_comment_mentions is
  'People mentioned in a comment (one row per person). Written only by the comment RPCs.';
create index work_item_comment_mentions_profile_idx on public.work_item_comment_mentions (profile_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 2. Integrity triggers (owner postgres)
-- -----------------------------------------------------------------------------
create function private.guard_work_item_comment_row()
returns trigger
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
begin
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.work_item_id is distinct from old.work_item_id
       or new.parent_comment_id is distinct from old.parent_comment_id or new.author_id is distinct from old.author_id
       or new.created_at is distinct from old.created_at then
      raise exception using errcode = '23514', message = 'comment_immutable', constraint = 'work_item_comments_immutable';
    end if;
    if old.deleted_at is not null and (new.deleted_at is null or new.body is not null) then
      raise exception using errcode = '23514', message = 'comment_deleted', constraint = 'work_item_comments_immutable';
    end if;
    return new;
  end if;

  -- One level only: a reply's parent must itself be a top-level comment (same item via the FK).
  if new.parent_comment_id is not null and exists (
       select 1 from public.work_item_comments as p where p.id = new.parent_comment_id and p.parent_comment_id is not null) then
    raise exception using errcode = '23514', message = 'invalid_parent_comment', constraint = 'work_item_comments_one_level';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_work_item_comment_row() from public, anon, authenticated, service_role;

create trigger work_item_comments_guard_row
  before insert or update on public.work_item_comments
  for each row execute function private.guard_work_item_comment_row();
create trigger work_item_comments_set_updated_at
  before update on public.work_item_comments
  for each row execute function private.set_updated_at();

create function private.prevent_work_item_comment_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '23514', message = 'Comments are soft-deleted, never removed.', constraint = 'work_item_comments_no_delete';
end;
$$;
revoke all on function private.prevent_work_item_comment_delete() from public, anon, authenticated, service_role;

create trigger work_item_comments_prevent_delete
  before delete on public.work_item_comments
  for each row execute function private.prevent_work_item_comment_delete();
create trigger work_item_comments_prevent_truncate
  before truncate on public.work_item_comments
  for each statement execute function private.prevent_work_item_comment_delete();

alter table public.work_item_comments enable always trigger work_item_comments_guard_row;
alter table public.work_item_comments enable always trigger work_item_comments_prevent_delete;
alter table public.work_item_comments enable always trigger work_item_comments_prevent_truncate;


-- -----------------------------------------------------------------------------
-- 3. Privileges and RLS
-- -----------------------------------------------------------------------------
alter table public.work_item_comments enable row level security;
alter table public.work_item_comment_mentions enable row level security;
revoke all on table public.work_item_comments from public, anon, authenticated, service_role, cyclo_project_api;
revoke all on table public.work_item_comment_mentions from public, anon, authenticated, service_role, cyclo_project_api;

-- Employees: read-only, same visibility as the work items themselves (the UI uses the RPCs).
grant select on table public.work_item_comments to authenticated;
create policy "Super admins read all comments"
  on public.work_item_comments for select to authenticated
  using ((select private.current_app_role()) = 'SUPER_ADMIN');
create policy "Project managers read comments of assigned projects"
  on public.work_item_comments for select to authenticated
  using ((select private.current_app_role()) = 'PROJECT_MANAGER' and private.is_assigned_project_manager(project_id));
create policy "Developers read comments of their projects"
  on public.work_item_comments for select to authenticated
  using ((select private.current_app_role()) = 'DEVELOPER' and private.is_project_member(project_id));

-- RPC owner: only the columns the RPCs write.
grant select on table public.work_item_comments to cyclo_project_api;
grant insert (project_id, work_item_id, parent_comment_id, author_id, body) on table public.work_item_comments to cyclo_project_api;
grant update (body, edited_at, deleted_at) on table public.work_item_comments to cyclo_project_api;
create policy "Project API role reads comments" on public.work_item_comments for select to cyclo_project_api using (true);
create policy "Project API role creates comments" on public.work_item_comments for insert to cyclo_project_api with check (true);
create policy "Project API role updates comments" on public.work_item_comments for update to cyclo_project_api using (true) with check (true);

grant select, insert, delete on table public.work_item_comment_mentions to cyclo_project_api;
create policy "Project API role reads mentions" on public.work_item_comment_mentions for select to cyclo_project_api using (true);
create policy "Project API role adds mentions" on public.work_item_comment_mentions for insert to cyclo_project_api with check (true);
create policy "Project API role removes mentions" on public.work_item_comment_mentions for delete to cyclo_project_api using (true);


-- -----------------------------------------------------------------------------
-- 4. Audit actions (content is never recorded)
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
  'WORK_ITEM_COMMENT_ADDED', 'WORK_ITEM_COMMENT_EDITED', 'WORK_ITEM_COMMENT_DELETED',
  'SPRINT_CREATED', 'SPRINT_UPDATED', 'SPRINT_CAPACITY_CHANGED',
  'SPRINT_STARTED', 'SPRINT_COMPLETED', 'SPRINT_CANCELLED'));


-- -----------------------------------------------------------------------------
-- 5. Implementations (owner cyclo_project_api; same transfer pattern as 8D-8G1)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Trimmed, LF-normalised body or 'invalid_comment'.
create function private.normalize_comment_body(p_body text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_body text := pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(coalesce(p_body, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \n\t');
begin
  if pg_catalog.char_length(v_body) not between 1 and 5000 or v_body ~ '[\x01-\x08\x0b-\x1f\x7f]' then
    raise exception using errcode = '22023', message = 'invalid_comment';
  end if;
  return v_body;
end;
$$;

-- Distinct mention ids in a body (lower-case uuids).
create function private.comment_mention_ids(p_body text)
returns uuid[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct m[1]::uuid), '{}')
    from pg_catalog.regexp_matches(coalesce(p_body, ''), '<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>', 'g') as m
$$;

-- Active employees who can access the project: Super Admins, the assigned PM, member developers.
create function private.is_comment_mentionable(p_project_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles as p
      join public.projects as pr on pr.id = p_project_id
     where p.id = p_profile_id
       and p.is_active
       and (p.role = 'SUPER_ADMIN'::public.app_role
            or (p.role = 'PROJECT_MANAGER'::public.app_role and pr.project_manager_id = p.id)
            or (p.role = 'DEVELOPER'::public.app_role and exists (
                  select 1 from public.project_members as m where m.project_id = pr.id and m.profile_id = p.id)))
  )
$$;

-- Replaces the comment's mentions with the tokens in p_body (validated). Returns the count.
create function private.sync_comment_mentions(p_comment_id uuid, p_project_id uuid, p_body text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := private.comment_mention_ids(p_body);
  v_id uuid;
begin
  if pg_catalog.cardinality(v_ids) > 20 then
    raise exception using errcode = '22023', message = 'too_many_mentions';
  end if;
  foreach v_id in array v_ids loop
    if not private.is_comment_mentionable(p_project_id, v_id) then
      raise exception using errcode = '22023', message = 'invalid_mention';
    end if;
  end loop;
  delete from public.work_item_comment_mentions as m
   where m.comment_id = p_comment_id and not (m.profile_id = any (v_ids));
  insert into public.work_item_comment_mentions (comment_id, profile_id)
  select p_comment_id, i from pg_catalog.unnest(v_ids) as i
  on conflict do nothing;
  return pg_catalog.cardinality(v_ids);
end;
$$;

-- Caller may read the item's discussion. Returns the project; hides items the caller cannot see.
create function private.comment_read_access(p_work_item_id uuid, out project_id uuid, out actor_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_work_item_id is null then
    raise exception using errcode = '22023', message = 'invalid_work_item_id';
  end if;
  select w.project_id into project_id from public.work_items as w where w.id = p_work_item_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end if;
  begin
    select a.actor_id into actor_id from private.work_item_access(project_id) as a;
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'work_item_not_found';
  end;
end;
$$;

-- Caller may write to the item's discussion (project and item not archived).
create function private.comment_write_access(p_work_item_id uuid, out project_id uuid, out actor_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  select a.project_id, a.actor_id into project_id, actor_id from private.comment_read_access(p_work_item_id) as a;
  if exists (select 1 from public.projects as pr where pr.id = project_id and pr.archived_at is not null) then
    raise exception using errcode = '55000', message = 'project_archived';
  end if;
  if exists (select 1 from public.work_items as w where w.id = p_work_item_id and w.archived_at is not null) then
    raise exception using errcode = '55000', message = 'work_item_archived';
  end if;
end;
$$;

-- Display rows for the given comments, in the given order (one query, no per-row lookups).
create function private.comment_details(p_ids uuid[])
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.work_item_id, c.parent_comment_id,
         c.author_id, a.full_name, a.avatar_kind, a.avatar_symbol,
         c.body, c.created_at, c.edited_at, c.deleted_at,
         case when c.parent_comment_id is null then (
           select pg_catalog.count(*)::integer from public.work_item_comments as r
            where r.parent_comment_id = c.id and r.deleted_at is null) else 0 end,
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name, p.id)
             from public.work_item_comment_mentions as m
             join public.profiles as p on p.id = m.profile_id
            where m.comment_id = c.id and c.deleted_at is null), '[]'::jsonb)
    from pg_catalog.unnest(p_ids) with ordinality as i(id, ord)
    join public.work_item_comments as c on c.id = i.id
    left join public.profiles as a on a.id = c.author_id
   order by i.ord
$$;

-- One page of threads (top-level comments, oldest first, after the cursor) plus
-- the first p_reply_limit replies of each. A deleted comment is listed only
-- while it still has visible replies; deleted replies are never listed.
create function private.list_work_item_comments(
  p_work_item_id uuid, p_after_created_at timestamptz, p_after_id uuid, p_limit integer, p_reply_limit integer
)
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
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if p_reply_limit is null or p_reply_limit < 0 or p_reply_limit > 50 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  select pg_catalog.array_agg(x.id order by x.thread_ord, x.reply_ord nulls first) into v_ids
    from (
      select t.id, t.ord as thread_ord, null::bigint as reply_ord
        from (
          select c.id, pg_catalog.row_number() over (order by c.created_at, c.id) as ord
            from public.work_item_comments as c
           where c.work_item_id = p_work_item_id and c.parent_comment_id is null
             and (p_after_created_at is null or (c.created_at, c.id) > (p_after_created_at, p_after_id))
             and (c.deleted_at is null or exists (
                   select 1 from public.work_item_comments as r where r.parent_comment_id = c.id and r.deleted_at is null))
           order by c.created_at, c.id
           limit p_limit
        ) as t
      union all
      select r.id, t.ord, r.ord
        from (
          select c.id, pg_catalog.row_number() over (order by c.created_at, c.id) as ord
            from public.work_item_comments as c
           where c.work_item_id = p_work_item_id and c.parent_comment_id is null
             and (p_after_created_at is null or (c.created_at, c.id) > (p_after_created_at, p_after_id))
             and (c.deleted_at is null or exists (
                   select 1 from public.work_item_comments as r2 where r2.parent_comment_id = c.id and r2.deleted_at is null))
           order by c.created_at, c.id
           limit p_limit
        ) as t
        cross join lateral (
          select r.id, pg_catalog.row_number() over (order by r.created_at, r.id) as ord
            from public.work_item_comments as r
           where r.parent_comment_id = t.id and r.deleted_at is null
           order by r.created_at, r.id
           limit p_reply_limit
        ) as r
    ) as x;

  return query select * from private.comment_details(coalesce(v_ids, '{}'));
end;
$$;

-- More replies of one thread, oldest first, after the cursor.
create function private.list_comment_replies(
  p_parent_comment_id uuid, p_after_created_at timestamptz, p_after_id uuid, p_limit integer
)
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
  v_item uuid;
  v_ids uuid[];
begin
  select c.work_item_id into v_item from public.work_item_comments as c
   where c.id = p_parent_comment_id and c.parent_comment_id is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'comment_not_found';
  end if;
  begin
    perform private.comment_read_access(v_item);
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'comment_not_found';
  end;
  if p_limit is null or p_limit < 1 or p_limit > 101 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  select pg_catalog.array_agg(r.id order by r.created_at, r.id) into v_ids
    from (
      select r.id, r.created_at from public.work_item_comments as r
       where r.parent_comment_id = p_parent_comment_id and r.deleted_at is null
         and (p_after_created_at is null or (r.created_at, r.id) > (p_after_created_at, p_after_id))
       order by r.created_at, r.id
       limit p_limit
    ) as r;

  return query select * from private.comment_details(coalesce(v_ids, '{}'));
end;
$$;

create function private.create_work_item_comment(p_work_item_id uuid, p_body text, p_parent_comment_id uuid)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_access record;
  v_body text := private.normalize_comment_body(p_body);
  v_parent record;
  v_id uuid;
  v_mentions integer;
begin
  select * into v_access from private.comment_write_access(p_work_item_id);

  if p_parent_comment_id is not null then
    select c.work_item_id, c.parent_comment_id, c.deleted_at into v_parent
      from public.work_item_comments as c where c.id = p_parent_comment_id for share;
    if not found or v_parent.work_item_id <> p_work_item_id or v_parent.parent_comment_id is not null then
      raise exception using errcode = '22023', message = 'invalid_parent_comment';
    end if;
    if v_parent.deleted_at is not null then
      raise exception using errcode = '55000', message = 'comment_deleted';
    end if;
  end if;

  insert into public.work_item_comments (project_id, work_item_id, parent_comment_id, author_id, body)
  values (v_access.project_id, p_work_item_id, p_parent_comment_id, v_access.actor_id, v_body)
  returning work_item_comments.id into v_id;

  v_mentions := private.sync_comment_mentions(v_id, v_access.project_id, v_body);

  perform private.audit_work_item(v_access.actor_id, v_access.project_id, p_work_item_id, 'WORK_ITEM_COMMENT_ADDED', '{}'::jsonb,
    pg_catalog.jsonb_build_object('comment_id', v_id, 'reply', p_parent_comment_id is not null, 'mentions', v_mentions));

  return query select * from private.comment_details(array[v_id]);
end;
$$;

-- Locks one of the caller's own comments for a change.
create function private.lock_own_comment(p_comment_id uuid, out project_id uuid, out work_item_id uuid, out actor_id uuid, out parent_comment_id uuid, out deleted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_author uuid;
begin
  if p_comment_id is null then
    raise exception using errcode = '22023', message = 'invalid_comment_id';
  end if;
  select c.work_item_id, c.author_id into work_item_id, v_author from public.work_item_comments as c where c.id = p_comment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'comment_not_found';
  end if;
  begin
    select a.project_id, a.actor_id into project_id, actor_id from private.comment_write_access(work_item_id) as a;
  exception when sqlstate 'P0002' then
    raise exception using errcode = 'P0002', message = 'comment_not_found';
  end;
  if v_author <> actor_id then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  select c.parent_comment_id, c.deleted_at into parent_comment_id, deleted_at
    from public.work_item_comments as c where c.id = p_comment_id for update;
end;
$$;

create function private.update_work_item_comment(p_comment_id uuid, p_body text)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lock record;
  v_body text := private.normalize_comment_body(p_body);
  v_old text;
  v_mentions integer;
begin
  select * into v_lock from private.lock_own_comment(p_comment_id);
  if v_lock.deleted_at is not null then
    raise exception using errcode = '55000', message = 'comment_deleted';
  end if;
  select c.body into v_old from public.work_item_comments as c where c.id = p_comment_id;

  -- Saving unchanged text is a no-op (no "edited" marker, no event).
  if v_old is distinct from v_body then
    update public.work_item_comments as c set body = v_body, edited_at = pg_catalog.now() where c.id = p_comment_id;
    v_mentions := private.sync_comment_mentions(p_comment_id, v_lock.project_id, v_body);
    perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, v_lock.work_item_id, 'WORK_ITEM_COMMENT_EDITED', '{}'::jsonb,
      pg_catalog.jsonb_build_object('comment_id', p_comment_id, 'reply', v_lock.parent_comment_id is not null, 'mentions', v_mentions));
  end if;

  return query select * from private.comment_details(array[p_comment_id]);
end;
$$;

-- Soft delete; deleting an already deleted comment is a no-op.
create function private.delete_work_item_comment(p_comment_id uuid)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lock record;
begin
  select * into v_lock from private.lock_own_comment(p_comment_id);
  if v_lock.deleted_at is null then
    update public.work_item_comments as c set body = null, deleted_at = pg_catalog.now() where c.id = p_comment_id;
    delete from public.work_item_comment_mentions as m where m.comment_id = p_comment_id;
    perform private.audit_work_item(v_lock.actor_id, v_lock.project_id, v_lock.work_item_id, 'WORK_ITEM_COMMENT_DELETED', '{}'::jsonb,
      pg_catalog.jsonb_build_object('comment_id', p_comment_id, 'reply', v_lock.parent_comment_id is not null));
  end if;
  return query select * from private.comment_details(array[p_comment_id]);
end;
$$;

-- Mention autocomplete: eligible people whose name matches, bounded (never the whole directory).
create function private.search_comment_mentions(p_work_item_id uuid, p_search text, p_limit integer)
returns table (id uuid, full_name text, role public.app_role, avatar_kind text, avatar_symbol text, is_project_manager boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_access record;
  v_search text := nullif(private.trim_text(p_search), '');
  v_pattern text;
begin
  select * into v_access from private.comment_read_access(p_work_item_id);
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if v_search is not null then
    if pg_catalog.char_length(v_search) > 60 then
      raise exception using errcode = '22023', message = 'invalid_search';
    end if;
    v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select p.id, p.full_name, p.role, p.avatar_kind, p.avatar_symbol, pr.project_manager_id = p.id
      from public.projects as pr
      join public.profiles as p on p.is_active and p.full_name is not null
       and (p.role = 'SUPER_ADMIN'::public.app_role
            or (p.role = 'PROJECT_MANAGER'::public.app_role and pr.project_manager_id = p.id)
            or (p.role = 'DEVELOPER'::public.app_role and exists (
                  select 1 from public.project_members as m where m.project_id = pr.id and m.profile_id = p.id)))
     where pr.id = v_access.project_id
       and (v_pattern is null or p.full_name operator(pg_catalog.~~*) v_pattern)
     order by (pr.project_manager_id = p.id) desc, (p.role = 'DEVELOPER'::public.app_role) desc,
              pg_catalog.lower(p.full_name), p.id
     limit p_limit;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.normalize_comment_body(text)',
    'private.comment_mention_ids(text)',
    'private.is_comment_mentionable(uuid, uuid)',
    'private.sync_comment_mentions(uuid, uuid, text)',
    'private.comment_read_access(uuid)',
    'private.comment_write_access(uuid)',
    'private.comment_details(uuid[])',
    'private.lock_own_comment(uuid)',
    'private.list_work_item_comments(uuid, timestamptz, uuid, integer, integer)',
    'private.list_comment_replies(uuid, timestamptz, uuid, integer)',
    'private.create_work_item_comment(uuid, text, uuid)',
    'private.update_work_item_comment(uuid, text)',
    'private.delete_work_item_comment(uuid)',
    'private.search_comment_mentions(uuid, text, integer)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'private.list_work_item_comments(uuid, timestamptz, uuid, integer, integer)',
    'private.list_comment_replies(uuid, timestamptz, uuid, integer)',
    'private.create_work_item_comment(uuid, text, uuid)',
    'private.update_work_item_comment(uuid, text)',
    'private.delete_work_item_comment(uuid)',
    'private.search_comment_mentions(uuid, text, integer)'
  ] loop
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 6. Public wrappers (SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create function public.list_work_item_comments(
  p_work_item_id uuid, p_after_created_at timestamptz default null, p_after_id uuid default null,
  p_limit integer default 21, p_reply_limit integer default 20
)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_work_item_comments(p_work_item_id, p_after_created_at, p_after_id, p_limit, p_reply_limit) $$;

create function public.list_comment_replies(
  p_parent_comment_id uuid, p_after_created_at timestamptz default null, p_after_id uuid default null, p_limit integer default 51
)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_comment_replies(p_parent_comment_id, p_after_created_at, p_after_id, p_limit) $$;

create function public.create_work_item_comment(p_work_item_id uuid, p_body text, p_parent_comment_id uuid default null)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql volatile security invoker set search_path = ''
as $$ select * from private.create_work_item_comment(p_work_item_id, p_body, p_parent_comment_id) $$;

create function public.update_work_item_comment(p_comment_id uuid, p_body text)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql volatile security invoker set search_path = ''
as $$ select * from private.update_work_item_comment(p_comment_id, p_body) $$;

create function public.delete_work_item_comment(p_comment_id uuid)
returns table (
  id uuid, work_item_id uuid, parent_comment_id uuid,
  author_id uuid, author_name text, author_avatar_kind text, author_avatar_symbol text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_count integer, mentions jsonb
)
language sql volatile security invoker set search_path = ''
as $$ select * from private.delete_work_item_comment(p_comment_id) $$;

create function public.search_comment_mentions(p_work_item_id uuid, p_search text default null, p_limit integer default 8)
returns table (id uuid, full_name text, role public.app_role, avatar_kind text, avatar_symbol text, is_project_manager boolean)
language sql stable security invoker set search_path = ''
as $$ select * from private.search_comment_mentions(p_work_item_id, p_search, p_limit) $$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.list_work_item_comments(uuid, timestamptz, uuid, integer, integer)',
    'public.list_comment_replies(uuid, timestamptz, uuid, integer)',
    'public.create_work_item_comment(uuid, text, uuid)',
    'public.update_work_item_comment(uuid, text)',
    'public.delete_work_item_comment(uuid)',
    'public.search_comment_mentions(uuid, text, integer)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

comment on function public.create_work_item_comment(uuid, text, uuid) is
  'Comment (or one-level reply) as the signed-in employee. Mentions are <@uuid> tokens, validated against project access.';

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   Drop the six public wrappers and, with the temporary cyclo_project_api
--   membership, the fourteen private functions above; drop tables
--   public.work_item_comment_mentions and public.work_item_comments (with their
--   triggers) and functions private.guard_work_item_comment_row() and
--   private.prevent_work_item_comment_delete(); delete the
--   WORK_ITEM_COMMENT_* audit rows and restore the 20261201100000 action check.
-- =============================================================================
