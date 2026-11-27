-- =============================================================================
-- CYCLO Phase 8G3: centralized notifications (local deployment only)
--
-- Source of events: the existing private.project_audit_log. Every workflow
-- already records its events there in the same transaction as the change, so
-- one AFTER INSERT trigger creates notifications transactionally, from trusted
-- database state (recipients are never supplied by a client). No workflow RPC
-- changes.
--
-- Events and recipients (never the actor; recipient must be active, still able
-- to access the project, and have the category enabled):
--   WORK_ITEM_COMMENT_ADDED   top-level: mentioned people (MENTIONED), the
--                             item's assignee and the project's PM (COMMENT_ADDED)
--                             reply: mentioned people (MENTIONED), the parent
--                             comment's author (COMMENT_REPLY), assignee and
--                             PM (REPLY_ADDED)
--   WORK_ITEM_COMMENT_EDITED  newly added mentions only (MENTIONED)
--   WORK_ITEM_COMMENT_DELETED nothing
--   WORK_ITEM_CREATED         initial assignee (WORK_ITEM_ASSIGNED)
--   WORK_ITEM_ASSIGNED        the new assignee (WORK_ITEM_ASSIGNED); not the previous one
--   WORK_ITEM_SUBMITTED_FOR_REVIEW  the project's PM (REVIEW_REQUESTED)
--   WORK_ITEM_REVIEW_APPROVED       the assignee (REVIEW_APPROVED)
--   WORK_ITEM_REVIEW_REJECTED       the assignee (REVIEW_CHANGES_REQUESTED)
--   WORK_ITEM_BLOCKED / _RESUMED    the project's PM and the assignee
--   PROJECT_MEMBER_ADDED            the added developer
--   PROJECT_CREATED / PROJECT_MANAGER_CHANGED  the (new) Project Manager
--
-- Idempotency: unique (recipient_id, dedupe_key). A comment uses
-- 'comment:<id>' for every rule, inserted in priority order (mention, reply to
-- your comment, assignee/PM), so each person gets exactly one notification per
-- comment, of the most specific kind. Other events use 'audit:<audit id>'.
--
-- Privacy: titles and messages are not stored. The read RPCs build them from
-- live data and return project/item/comment details only while the recipient
-- can still access the project. Realtime streams this table to the recipient
-- only (RLS: recipient_id = auth.uid()); its rows hold ids and types, no text.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table public.notifications (
  id           uuid        primary key default gen_random_uuid(),
  recipient_id uuid        not null references public.profiles (id) on delete cascade,
  actor_id     uuid        references public.profiles (id) on delete set null,
  event_type   text        not null check (event_type in (
    'MENTIONED', 'COMMENT_REPLY', 'COMMENT_ADDED', 'REPLY_ADDED',
    'WORK_ITEM_ASSIGNED', 'REVIEW_REQUESTED', 'REVIEW_APPROVED', 'REVIEW_CHANGES_REQUESTED',
    'WORK_ITEM_BLOCKED', 'WORK_ITEM_RESUMED', 'PROJECT_MEMBER_ADDED', 'PROJECT_MANAGER_ASSIGNED')),
  category     text        not null check (category in ('assignment', 'comment', 'mention', 'review_requested', 'review_decision', 'blocked', 'project')),
  project_id   uuid        not null references public.projects (id) on delete cascade,
  work_item_id uuid        references public.work_items (id) on delete cascade,
  comment_id   uuid        references public.work_item_comments (id) on delete cascade,
  audit_id     uuid        not null,
  dedupe_key   text        not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  constraint notifications_recipient_dedupe_key unique (recipient_id, dedupe_key),
  constraint notifications_not_self check (actor_id is null or actor_id <> recipient_id)
);
comment on table public.notifications is
  'In-app notifications. Created only by the audit-log trigger; read and marked read only by the recipient through RPCs.';

create index notifications_recipient_created_idx on public.notifications (recipient_id, created_at desc, id desc);
create index notifications_recipient_unread_idx on public.notifications (recipient_id, created_at desc) where read_at is null;
create index notifications_recipient_category_idx on public.notifications (recipient_id, category, created_at desc);
create index notifications_project_idx on public.notifications (project_id);
create index notifications_work_item_idx on public.notifications (work_item_id) where work_item_id is not null;
create index notifications_comment_idx on public.notifications (comment_id) where comment_id is not null;
create index notifications_actor_idx on public.notifications (actor_id) where actor_id is not null;

-- Absent row = enabled. 'in_app' today; an 'email' column can be added later.
create table public.notification_preferences (
  profile_id uuid        not null references public.profiles (id) on delete cascade,
  category   text        not null check (category in ('assignment', 'comment', 'mention', 'review_requested', 'review_decision', 'blocked', 'project')),
  in_app     boolean     not null default true,
  updated_at timestamptz not null default now(),
  primary key (profile_id, category)
);
comment on table public.notification_preferences is 'Per-category notification switches (absent = enabled). Written only through RPCs.';

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
revoke all on table public.notifications from public, anon, authenticated, service_role;
revoke all on table public.notification_preferences from public, anon, authenticated, service_role;

-- Recipients read their own rows (Realtime evaluates this policy per subscriber).
grant select on table public.notifications to authenticated;
create policy "Recipients read their notifications" on public.notifications
  for select to authenticated using (recipient_id = (select auth.uid()));

-- RPC owner: read and mark read only (rows are created by the owner-level trigger).
grant select on table public.notifications to cyclo_project_api;
grant update (read_at) on table public.notifications to cyclo_project_api;
create policy "Project API role reads notifications" on public.notifications for select to cyclo_project_api using (true);
create policy "Project API role marks notifications read" on public.notifications for update to cyclo_project_api using (true) with check (true);
grant select, insert, update on table public.notification_preferences to cyclo_project_api;
create policy "Project API role reads preferences" on public.notification_preferences for select to cyclo_project_api using (true);
create policy "Project API role writes preferences" on public.notification_preferences for insert to cyclo_project_api with check (true);
create policy "Project API role updates preferences" on public.notification_preferences for update to cyclo_project_api using (true) with check (true);


-- -----------------------------------------------------------------------------
-- 2. Generation (owner postgres; runs inside the event's transaction)
-- -----------------------------------------------------------------------------
-- Active employee who can access the project today (same rule as project reads).
create function private.profile_can_access_project(p_profile_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
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
revoke all on function private.profile_can_access_project(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.profile_can_access_project(uuid, uuid) to cyclo_project_api;

-- One candidate notification; silently skipped when not allowed or already sent.
create function private.notify(
  p_recipient uuid, p_actor uuid, p_event text, p_category text,
  p_project uuid, p_item uuid, p_comment uuid, p_audit uuid, p_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
begin
  if p_recipient is null or p_recipient = p_actor then
    return;
  end if;
  if not private.profile_can_access_project(p_recipient, p_project) then
    return;
  end if;
  if exists (select 1 from public.notification_preferences as np
              where np.profile_id = p_recipient and np.category = p_category and not np.in_app) then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, event_type, category, project_id, work_item_id, comment_id, audit_id, dedupe_key)
  values (p_recipient, p_actor, p_event, p_category, p_project, p_item, p_comment, p_audit, p_key)
  on conflict (recipient_id, dedupe_key) do nothing;
end;
$$;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

create function private.notify_from_audit()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_assignee uuid;
  v_pm uuid;
  v_comment uuid;
  v_parent uuid;
  v_parent_author uuid;
  v_reply boolean;
  v_key text := 'audit:' || new.id;
  v_mention uuid;
begin
  select pr.project_manager_id into v_pm from public.projects as pr where pr.id = new.project_id;
  if new.work_item_id is not null then
    select w.assignee_id into v_assignee from public.work_items as w where w.id = new.work_item_id;
  end if;

  case new.action
    when 'WORK_ITEM_COMMENT_ADDED', 'WORK_ITEM_COMMENT_EDITED' then
      v_comment := (new.new_values ->> 'comment_id')::uuid;
      select c.parent_comment_id into v_parent from public.work_item_comments as c where c.id = v_comment;
      if not found then
        return null;
      end if;
      v_key := 'comment:' || v_comment;
      v_reply := v_parent is not null;

      -- Mentions first (most specific). On an edit only mentions added by this
      -- edit: kept mention rows retain their original created_at.
      for v_mention in
        select m.profile_id from public.work_item_comment_mentions as m
         where m.comment_id = v_comment
           and (new.action = 'WORK_ITEM_COMMENT_ADDED' or m.created_at = pg_catalog.now())
         order by m.profile_id
      loop
        perform private.notify(v_mention, new.actor_id, 'MENTIONED', 'mention', new.project_id, new.work_item_id, v_comment, new.id, v_key);
      end loop;

      if new.action = 'WORK_ITEM_COMMENT_ADDED' then
        if v_reply then
          select c.author_id into v_parent_author from public.work_item_comments as c where c.id = v_parent;
          perform private.notify(v_parent_author, new.actor_id, 'COMMENT_REPLY', 'comment', new.project_id, new.work_item_id, v_comment, new.id, v_key);
        end if;
        perform private.notify(v_assignee, new.actor_id, case when v_reply then 'REPLY_ADDED' else 'COMMENT_ADDED' end, 'comment',
                               new.project_id, new.work_item_id, v_comment, new.id, v_key);
        perform private.notify(v_pm, new.actor_id, case when v_reply then 'REPLY_ADDED' else 'COMMENT_ADDED' end, 'comment',
                               new.project_id, new.work_item_id, v_comment, new.id, v_key);
      end if;

    when 'WORK_ITEM_CREATED' then
      perform private.notify((new.new_values ->> 'assignee_id')::uuid, new.actor_id, 'WORK_ITEM_ASSIGNED', 'assignment',
                             new.project_id, new.work_item_id, null, new.id, v_key);

    when 'WORK_ITEM_ASSIGNED' then
      if (new.new_values ->> 'assignee_id') is distinct from (new.old_values ->> 'assignee_id') then
        perform private.notify((new.new_values ->> 'assignee_id')::uuid, new.actor_id, 'WORK_ITEM_ASSIGNED', 'assignment',
                               new.project_id, new.work_item_id, null, new.id, v_key);
      end if;

    when 'WORK_ITEM_SUBMITTED_FOR_REVIEW' then
      perform private.notify(v_pm, new.actor_id, 'REVIEW_REQUESTED', 'review_requested', new.project_id, new.work_item_id, null, new.id, v_key);

    when 'WORK_ITEM_REVIEW_APPROVED' then
      perform private.notify(v_assignee, new.actor_id, 'REVIEW_APPROVED', 'review_decision', new.project_id, new.work_item_id, null, new.id, v_key);

    when 'WORK_ITEM_REVIEW_REJECTED' then
      perform private.notify(v_assignee, new.actor_id, 'REVIEW_CHANGES_REQUESTED', 'review_decision', new.project_id, new.work_item_id, null, new.id, v_key);

    when 'WORK_ITEM_BLOCKED', 'WORK_ITEM_RESUMED' then
      perform private.notify(v_pm, new.actor_id, new.action, 'blocked', new.project_id, new.work_item_id, null, new.id, v_key);
      perform private.notify(v_assignee, new.actor_id, new.action, 'blocked', new.project_id, new.work_item_id, null, new.id, v_key);

    when 'PROJECT_MEMBER_ADDED' then
      perform private.notify((new.new_values ->> 'profile_id')::uuid, new.actor_id, 'PROJECT_MEMBER_ADDED', 'project', new.project_id, null, null, new.id, v_key);

    when 'PROJECT_CREATED', 'PROJECT_MANAGER_CHANGED' then
      perform private.notify((new.new_values ->> 'project_manager_id')::uuid, new.actor_id, 'PROJECT_MANAGER_ASSIGNED', 'project', new.project_id, null, null, new.id, v_key);

    else
      null;
  end case;
  return null;
end;
$$;
revoke all on function private.notify_from_audit() from public, anon, authenticated, service_role;

create trigger project_audit_log_notify
  after insert on private.project_audit_log
  for each row execute function private.notify_from_audit();
alter table private.project_audit_log enable always trigger project_audit_log_notify;


-- -----------------------------------------------------------------------------
-- 3. Read / mark read / preferences (owner cyclo_project_api)
-- -----------------------------------------------------------------------------
grant cyclo_project_api to postgres with inherit false, set true;
grant create on schema private to cyclo_project_api;

set role cyclo_project_api;

-- Display rows for the caller's notifications, in the given order. Project,
-- item and comment details only while the caller can still access the project.
create function private.notification_details(p_actor uuid, p_ids uuid[])
returns table (
  id uuid, event_type text, category text, created_at timestamptz, read_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  accessible boolean, project_id uuid, project_name text, project_key text,
  work_item_id uuid, issue_key text, work_item_title text,
  comment_id uuid, comment_body text, comment_mentions jsonb, reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.event_type, n.category, n.created_at, n.read_at,
         n.actor_id, a.full_name, a.avatar_kind, a.avatar_symbol,
         x.ok,
         case when x.ok then n.project_id end, case when x.ok then pr.name end, case when x.ok then pr.project_key end,
         case when x.ok then n.work_item_id end, case when x.ok then w.issue_key end, case when x.ok then w.title end,
         case when x.ok then n.comment_id end,
         case when x.ok and c.deleted_at is null then pg_catalog.left(c.body, 400) end,
         case when x.ok and c.deleted_at is null then coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id, 'name', p.full_name))
             from public.work_item_comment_mentions as m join public.profiles as p on p.id = m.profile_id
            where m.comment_id = c.id), '[]'::jsonb) else '[]'::jsonb end,
         case when x.ok and n.event_type in ('REVIEW_CHANGES_REQUESTED', 'WORK_ITEM_BLOCKED') then l.new_values ->> 'reason' end
    from pg_catalog.unnest(p_ids) with ordinality as i(id, ord)
    join public.notifications as n on n.id = i.id and n.recipient_id = p_actor
    left join public.profiles as a on a.id = n.actor_id
    left join public.projects as pr on pr.id = n.project_id
    left join public.work_items as w on w.id = n.work_item_id
    left join public.work_item_comments as c on c.id = n.comment_id
    left join private.project_audit_log as l on l.id = n.audit_id
    cross join lateral (select private.profile_can_access_project(p_actor, n.project_id) as ok) as x
   order by i.ord
$$;

create function private.list_notifications(
  p_status text, p_category text, p_before_created_at timestamptz, p_before_id uuid, p_limit integer
)
returns table (
  id uuid, event_type text, category text, created_at timestamptz, read_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  accessible boolean, project_id uuid, project_name text, project_key text,
  work_item_id uuid, issue_key text, work_item_title text,
  comment_id uuid, comment_body text, comment_mentions jsonb, reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_ids uuid[];
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  if p_status is null or p_status not in ('all', 'unread', 'read') then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_category is not null and p_category not in ('assignment', 'comment', 'mention', 'review_requested', 'review_decision', 'blocked', 'project') then
    raise exception using errcode = '22023', message = 'invalid_filter';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  select pg_catalog.array_agg(n.id order by n.created_at desc, n.id desc) into v_ids
    from (
      select n.id, n.created_at from public.notifications as n
       where n.recipient_id = v_actor
         and (p_status = 'all' or (p_status = 'unread') = (n.read_at is null))
         and (p_category is null or n.category = p_category)
         and (p_before_created_at is null or (n.created_at, n.id) < (p_before_created_at, p_before_id))
       order by n.created_at desc, n.id desc
       limit p_limit
    ) as n;
  return query select * from private.notification_details(v_actor, coalesce(v_ids, '{}'));
end;
$$;

-- Re-read specific notifications of the caller (Realtime events are signals only).
create function private.get_notifications(p_ids uuid[])
returns table (
  id uuid, event_type text, category text, created_at timestamptz, read_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  accessible boolean, project_id uuid, project_name text, project_key text,
  work_item_id uuid, issue_key text, work_item_title text,
  comment_id uuid, comment_body text, comment_mentions jsonb, reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_ids uuid[];
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  if p_ids is null or pg_catalog.cardinality(p_ids) > 50 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  select pg_catalog.array_agg(n.id order by n.created_at desc, n.id desc) into v_ids
    from public.notifications as n where n.id = any (p_ids) and n.recipient_id = v_actor;
  return query select * from private.notification_details(v_actor, coalesce(v_ids, '{}'));
end;
$$;

create function private.notification_unread_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  return (select pg_catalog.count(*)::integer from public.notifications as n where n.recipient_id = v_actor and n.read_at is null);
end;
$$;

-- Marks the caller's own notifications read (others' ids are ignored). Returns the new unread count.
create function private.mark_notifications_read(p_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  if p_ids is null or pg_catalog.cardinality(p_ids) > 100 then
    raise exception using errcode = '22023', message = 'invalid_limit';
  end if;
  update public.notifications as n set read_at = pg_catalog.now()
   where n.id = any (p_ids) and n.recipient_id = v_actor and n.read_at is null;
  return (select pg_catalog.count(*)::integer from public.notifications as n where n.recipient_id = v_actor and n.read_at is null);
end;
$$;

create function private.mark_all_notifications_read()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  update public.notifications as n set read_at = pg_catalog.now() where n.recipient_id = v_actor and n.read_at is null;
  return 0;
end;
$$;

create function private.get_notification_preferences()
returns table (category text, in_app boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor uuid;
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  return query
    select c.category, coalesce(np.in_app, true)
      from pg_catalog.unnest(array['assignment', 'comment', 'mention', 'review_requested', 'review_decision', 'blocked', 'project'])
           with ordinality as c(category, ord)
      left join public.notification_preferences as np on np.profile_id = v_actor and np.category = c.category
     order by c.ord;
end;
$$;

create function private.set_notification_preference(p_category text, p_in_app boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  select a.actor_id into v_actor from private.project_actor() as a;
  if p_category is null or p_category not in ('assignment', 'comment', 'mention', 'review_requested', 'review_decision', 'blocked', 'project') or p_in_app is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  insert into public.notification_preferences (profile_id, category, in_app) values (v_actor, p_category, p_in_app)
  on conflict (profile_id, category) do update set in_app = excluded.in_app, updated_at = pg_catalog.now();
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.notification_details(uuid, uuid[])',
    'private.list_notifications(text, text, timestamptz, uuid, integer)',
    'private.get_notifications(uuid[])',
    'private.notification_unread_count()',
    'private.mark_notifications_read(uuid[])',
    'private.mark_all_notifications_read()',
    'private.get_notification_preferences()',
    'private.set_notification_preference(text, boolean)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    if v_signature <> 'private.notification_details(uuid, uuid[])' then
      execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
    end if;
  end loop;
end;
$$;

reset role;

revoke create on schema private from cyclo_project_api;
revoke cyclo_project_api from postgres;


-- -----------------------------------------------------------------------------
-- 4. Public wrappers (SECURITY INVOKER) and Realtime
-- -----------------------------------------------------------------------------
create function public.list_notifications(
  p_status text default 'all', p_category text default null,
  p_before_created_at timestamptz default null, p_before_id uuid default null, p_limit integer default 21
)
returns table (
  id uuid, event_type text, category text, created_at timestamptz, read_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  accessible boolean, project_id uuid, project_name text, project_key text,
  work_item_id uuid, issue_key text, work_item_title text,
  comment_id uuid, comment_body text, comment_mentions jsonb, reason text
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_notifications(p_status, p_category, p_before_created_at, p_before_id, p_limit) $$;

create function public.get_notifications(p_ids uuid[])
returns table (
  id uuid, event_type text, category text, created_at timestamptz, read_at timestamptz,
  actor_id uuid, actor_name text, actor_avatar_kind text, actor_avatar_symbol text,
  accessible boolean, project_id uuid, project_name text, project_key text,
  work_item_id uuid, issue_key text, work_item_title text,
  comment_id uuid, comment_body text, comment_mentions jsonb, reason text
)
language sql stable security invoker set search_path = ''
as $$ select * from private.get_notifications(p_ids) $$;

create function public.notification_unread_count()
returns integer language sql stable security invoker set search_path = ''
as $$ select private.notification_unread_count() $$;

create function public.mark_notifications_read(p_ids uuid[])
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.mark_notifications_read(p_ids) $$;

create function public.mark_all_notifications_read()
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.mark_all_notifications_read() $$;

create function public.get_notification_preferences()
returns table (category text, in_app boolean) language sql stable security invoker set search_path = ''
as $$ select * from private.get_notification_preferences() $$;

create function public.set_notification_preference(p_category text, p_in_app boolean)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.set_notification_preference(p_category, p_in_app) $$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.list_notifications(text, text, timestamptz, uuid, integer)',
    'public.get_notifications(uuid[])',
    'public.notification_unread_count()',
    'public.mark_notifications_read(uuid[])',
    'public.mark_all_notifications_read()',
    'public.get_notification_preferences()',
    'public.set_notification_preference(text, boolean)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;

alter publication supabase_realtime add table public.notifications;

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres)
--   alter publication supabase_realtime drop table public.notifications;
--   drop trigger project_audit_log_notify on private.project_audit_log;
--   drop the seven public wrappers, the eight private RPCs (with the temporary
--   cyclo_project_api membership), private.notify_from_audit(), private.notify(...),
--   private.profile_can_access_project(uuid, uuid);
--   drop table public.notification_preferences, public.notifications.
-- =============================================================================
