-- Phase 8G3: notifications generated from the audit log; recipient rules,
-- deduplication, preferences, isolation and authorization. Rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures: SA; pm1 (project one), pm2 (project two); dev1, dev2 on project one;
-- dev3 on project two; dev4 (no project yet).
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',   '89000000-0000-4000-a000-000000000001'),
  ('pm1',  '89000000-0000-4000-a000-000000000002'),
  ('pm2',  '89000000-0000-4000-a000-000000000003'),
  ('dev1', '89000000-0000-4000-a000-000000000004'),
  ('dev2', '89000000-0000-4000-a000-000000000005'),
  ('dev3', '89000000-0000-4000-a000-000000000006'),
  ('dev4', '89000000-0000-4000-a000-000000000007');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8g3-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8G3 ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN' where id = '89000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('89000000-0000-4000-a000-000000000002', '89000000-0000-4000-a000-000000000003');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create function pg_temp.tok(p_key text) returns text language sql as $$ select '<@' || (select id from t_users where key = p_key) || '>' $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;
-- recipient:event for notifications about one comment / work item / project (as the table owner).
create function pg_temp.about_comment(p_key text) returns text[] language sql as $$
  select coalesce(array_agg(t.key || ':' || n.event_type order by t.key), '{}') from public.notifications n join t_users t on t.id = n.recipient_id
   where n.comment_id = (select id from t_ids where key = p_key)
$$;
create function pg_temp.about_item(p_key text, p_event text) returns text[] language sql as $$
  select coalesce(array_agg(t.key order by t.key), '{}') from public.notifications n join t_users t on t.id = n.recipient_id
   where n.work_item_id = (select id from t_ids where key = p_key) and n.event_type = p_event
$$;
create function pg_temp.total() returns integer language sql as $$
  select count(*)::int from public.notifications where recipient_id in (select id from t_users)
$$;

-- SA creates project one for pm1 (pm1 is notified), pm2 creates project two for themself (no self-notification).
select pg_temp.login('sa'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8G3 One', 'NTA', 'medium', p_project_manager_id => pg_temp.uid('pm1')));
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8G3 Two', 'NTB', 'medium'));
select public.add_project_member(pg_temp.id('p2'), pg_temp.uid('dev3'));
insert into t_ids values ('b', public.create_work_item(pg_temp.id('p2'), 'TASK', 'Other project task', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev3')));
reset role;
select is((select array_agg(t.key || ':' || n.event_type) from public.notifications n join t_users t on t.id = n.recipient_id where n.project_id = pg_temp.id('p1')),
  array['pm1:PROJECT_MANAGER_ASSIGNED'], 'a PM is told about a project created for them');
select is((select count(*)::int from public.notifications where project_id = pg_temp.id('p2') and event_type = 'PROJECT_MANAGER_ASSIGNED'), 0, 'no self-notification for one''s own project');

select pg_temp.login('pm1'); set local role authenticated;
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
insert into t_ids values ('a', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Notified task', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1')));
insert into t_ids values ('epic', public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Unassigned epic'));
reset role;
select is((select array_agg(t.key order by t.key) from public.notifications n join t_users t on t.id = n.recipient_id where n.project_id = pg_temp.id('p1') and n.event_type = 'PROJECT_MEMBER_ADDED'),
  array['dev1', 'dev2'], 'developers are told they joined a team');
select is(pg_temp.about_item('a', 'WORK_ITEM_ASSIGNED'), array['dev1'], 'assigned at creation');

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.notifications', 'insert'), 'no direct inserts');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'update'), 'no direct updates');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'delete'), 'no direct deletes');
select ok(not has_table_privilege('authenticated', 'public.notification_preferences', 'select'), 'preferences only through RPCs');
select ok(not has_table_privilege('cyclo_project_api', 'public.notifications', 'insert'), 'only the trigger creates notifications');
select ok(not has_function_privilege('authenticated', 'private.notify(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text)', 'execute'), 'generation is internal');
select ok(not has_function_privilege('anon', 'public.list_notifications(text,text,timestamptz,uuid,integer)', 'execute'), 'anon cannot read');
select ok((select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), 'RLS on notifications');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications'), 'published for Realtime');
select ok(not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notification_preferences'), 'preferences are not streamed');
select has_index('public', 'notifications', 'notifications_recipient_unread_idx', 'unread index');
select has_index('public', 'notifications', 'notifications_recipient_created_idx', 'history index');

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
-- dev2 comments on dev1's task: assignee and PM notified, not the author.
select pg_temp.login('dev2'); set local role authenticated;
insert into t_ids select 'c1', id from public.create_work_item_comment(pg_temp.id('a'), 'Top-level from dev2');
reset role;
select is(pg_temp.about_comment('c1'), array['dev1:COMMENT_ADDED', 'pm1:COMMENT_ADDED'], 'top-level comment: assignee and PM');

-- The assignee comments on their own task: only the PM.
select pg_temp.login('dev1'); set local role authenticated;
insert into t_ids select 'c2', id from public.create_work_item_comment(pg_temp.id('a'), 'Assignee comments');
reset role;
select is(pg_temp.about_comment('c2'), array['pm1:COMMENT_ADDED'], 'no self-notification for the assignee');

-- Comments on an unassigned epic: the PM only; the PM commenting there: nobody.
select pg_temp.login('dev2'); set local role authenticated;
insert into t_ids select 'c_epic', id from public.create_work_item_comment(pg_temp.id('epic'), 'On the epic');
reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids select 'c_epic_pm', id from public.create_work_item_comment(pg_temp.id('epic'), 'PM on the epic');
reset role;
select is(pg_temp.about_comment('c_epic'), array['pm1:COMMENT_ADDED'], 'every work item type is covered');
select is(pg_temp.about_comment('c_epic_pm'), '{}'::text[], 'the PM is not notified about their own comment');

-- A reply: parent author (as a reply to them), assignee and PM, never the replier.
select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids select 'r1', id from public.create_work_item_comment(pg_temp.id('a'), 'PM replies', pg_temp.id('c1'));
reset role;
select is(pg_temp.about_comment('r1'), array['dev1:REPLY_ADDED', 'dev2:COMMENT_REPLY'], 'reply: parent author and assignee; not the PM who replied');

-- Overlap: the parent author is also the assignee → one notification, the most specific kind.
select pg_temp.login('dev2'); set local role authenticated;
insert into t_ids select 'r2', id from public.create_work_item_comment(pg_temp.id('a'), 'dev2 replies to the assignee', pg_temp.id('c2'));
reset role;
select is(pg_temp.about_comment('r2'), array['dev1:COMMENT_REPLY', 'pm1:REPLY_ADDED'], 'parent author and assignee are one person: one notification');

-- Mentions: SA is not otherwise involved; pm1 and dev1 already would be.
select pg_temp.login('dev2'); set local role authenticated;
insert into t_ids select 'm1', id from public.create_work_item_comment(pg_temp.id('a'),
  'Heads up ' || pg_temp.tok('sa') || ' ' || pg_temp.tok('pm1') || ' ' || pg_temp.tok('dev1') || ' ' || pg_temp.tok('dev1'));
reset role;
select is(pg_temp.about_comment('m1'), array['dev1:MENTIONED', 'pm1:MENTIONED', 'sa:MENTIONED'], 'mentions reach uninvolved people; overlaps collapse into one MENTIONED');
select is((select count(*)::int from public.notifications where comment_id = pg_temp.id('m1')), 3, 'one row per recipient');

-- Edits: no notification for an ordinary edit or an existing mention; only new mentions.
update public.notifications set read_at = now() where comment_id = pg_temp.id('m1');
update public.work_item_comment_mentions set created_at = now() - interval '1 hour' where comment_id = pg_temp.id('m1');
select pg_temp.login('dev2'); set local role authenticated;
select * from public.update_work_item_comment(pg_temp.id('c1'), 'Top-level from dev2, reworded');
select * from public.update_work_item_comment(pg_temp.id('m1'), 'Heads up ' || pg_temp.tok('sa') || ' ' || pg_temp.tok('pm1') || ' (edited)');
reset role;
select is(pg_temp.about_comment('c1'), array['dev1:COMMENT_ADDED', 'pm1:COMMENT_ADDED'], 'an ordinary edit notifies nobody');
select is((select count(*)::int from public.notifications where comment_id = pg_temp.id('m1') and read_at is null), 0, 'kept mentions are not re-notified');

-- A new mention by edit (dev2 mentions SA on c1, where SA had nothing yet).
select pg_temp.login('dev2'); set local role authenticated;
select * from public.update_work_item_comment(pg_temp.id('c1'), 'Top-level from dev2 ' || pg_temp.tok('sa'));
reset role;
select is(pg_temp.about_comment('c1'), array['dev1:COMMENT_ADDED', 'pm1:COMMENT_ADDED', 'sa:MENTIONED'], 'a newly added mention notifies once');
-- Adding a mention for someone already notified about this comment does not duplicate.
select pg_temp.login('dev2'); set local role authenticated;
select * from public.update_work_item_comment(pg_temp.id('c1'), 'Top-level from dev2 ' || pg_temp.tok('sa') || ' ' || pg_temp.tok('dev1'));
reset role;
select is((select count(*)::int from public.notifications where comment_id = pg_temp.id('c1') and recipient_id = pg_temp.uid('dev1')), 1, 'still one notification for dev1');

-- Deleting a comment notifies nobody.
create temporary table t_before on commit drop as select pg_temp.total() as n;
select pg_temp.login('dev2'); set local role authenticated;
select * from public.delete_work_item_comment(pg_temp.id('c1'));
reset role;
select is(pg_temp.total(), (select n from t_before), 'deleting a comment notifies nobody');

-- -----------------------------------------------------------------------------
-- Assignment, review and blocked work
-- -----------------------------------------------------------------------------
select pg_temp.login('pm1'); set local role authenticated;
select public.assign_work_item(pg_temp.id('a'), pg_temp.uid('dev2'));
reset role;
select is(pg_temp.about_item('a', 'WORK_ITEM_ASSIGNED'), array['dev1', 'dev2'], 'reassignment notifies the new assignee only (dev1 has only their original assignment)');
select is((select count(*)::int from public.notifications where work_item_id = pg_temp.id('a') and event_type = 'WORK_ITEM_ASSIGNED' and recipient_id = pg_temp.uid('dev1')), 1, 'the previous assignee gets nothing new');
select pg_temp.login('pm1'); set local role authenticated;
select public.assign_work_item(pg_temp.id('a'), pg_temp.uid('dev2'));
reset role;
select is((select count(*)::int from public.notifications where work_item_id = pg_temp.id('a') and event_type = 'WORK_ITEM_ASSIGNED' and recipient_id = pg_temp.uid('dev2')), 1, 'assigning the same person again is not a new assignment');

select pg_temp.login('dev2'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('a'), 'block', 'IN_PROGRESS', 'Waiting for API keys');
reset role;
select is(pg_temp.about_item('a', 'WORK_ITEM_BLOCKED'), array['pm1'], 'blocked by the assignee: the PM');
select pg_temp.login('pm1'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'resume', 'BLOCKED');
reset role;
select is(pg_temp.about_item('a', 'WORK_ITEM_RESUMED'), array['dev2'], 'resumed by the PM: the assignee');
select pg_temp.login('dev2'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'IN_PROGRESS');
reset role;
select is(pg_temp.about_item('a', 'REVIEW_REQUESTED'), array['pm1'], 'review requested: the PM');
select pg_temp.login('pm1'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'reject', 'IN_REVIEW', 'Add error handling');
reset role;
select is(pg_temp.about_item('a', 'REVIEW_CHANGES_REQUESTED'), array['dev2'], 'changes requested: the assignee');
select pg_temp.login('dev2'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'IN_PROGRESS');
reset role; select pg_temp.login('sa'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW');
select is((select changed from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')), false, 'a retried approval');
reset role;
select is(pg_temp.about_item('a', 'REVIEW_APPROVED'), array['dev2'], 'approved (by the SA): the assignee, once despite the retry');
select is(pg_temp.about_item('a', 'REVIEW_REQUESTED'), array['pm1', 'pm1'], 'each submission is its own request');

-- -----------------------------------------------------------------------------
-- Preferences (enforced at creation)
-- -----------------------------------------------------------------------------
select pg_temp.login('pm1'); set local role authenticated;
select public.set_notification_preference('comment', false);
select is((select in_app from public.get_notification_preferences() where category = 'comment'), false, 'preference saved');
select is((select count(*)::int from public.get_notification_preferences() where in_app), 6, 'other categories default to on');
select throws_ok($q$select public.set_notification_preference('email_digest', false)$q$, '22023', 'invalid_input', 'categories are allow-listed');
reset role; select pg_temp.login('dev1'); set local role authenticated;
insert into t_ids select 'c_pref', id from public.create_work_item_comment(pg_temp.id('a'), 'After pm1 muted comments');
insert into t_ids select 'c_pref_m', id from public.create_work_item_comment(pg_temp.id('a'), 'But mentions still reach ' || pg_temp.tok('pm1'));
reset role;
select is(pg_temp.about_comment('c_pref'), array['dev2:COMMENT_ADDED'], 'a muted category is not created');
select is(pg_temp.about_comment('c_pref_m'), array['dev2:COMMENT_ADDED', 'pm1:MENTIONED'], 'other categories still arrive');
select pg_temp.login('pm1'); set local role authenticated;
select public.set_notification_preference('mention', false);
select public.set_notification_preference('comment', true);
reset role; select pg_temp.login('dev1'); set local role authenticated;
insert into t_ids select 'c_fallback', id from public.create_work_item_comment(pg_temp.id('a'), 'Muted mention ' || pg_temp.tok('pm1'));
reset role;
select is(pg_temp.about_comment('c_fallback'), array['dev2:COMMENT_ADDED', 'pm1:COMMENT_ADDED'], 'with mentions muted, the PM still gets the comment notification');

-- -----------------------------------------------------------------------------
-- Eligibility and isolation
-- -----------------------------------------------------------------------------
-- A developer removed from the team is not notified any more, even as parent author.
select pg_temp.login('pm1'); set local role authenticated;
select public.remove_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
insert into t_ids select 'r_removed', id from public.create_work_item_comment(pg_temp.id('a'), 'Reply to a former member', pg_temp.id('c2'));
reset role;
select is(pg_temp.about_comment('r_removed'), array['dev2:REPLY_ADDED'], 'former members receive nothing');

select pg_temp.login('dev1'); set local role authenticated;
select is((select count(*)::int from public.notifications), (select count(*)::int from public.notifications where recipient_id = pg_temp.uid('dev1')), 'RLS: only one''s own rows');
select is((select count(*)::int from public.list_notifications(p_limit => 51) where not accessible), (select count(*)::int from public.list_notifications(p_limit => 51)), 'after removal, old notifications are kept but marked inaccessible');
select is((select count(*)::int from public.list_notifications(p_limit => 51) where project_name is not null or work_item_title is not null or comment_body is not null), 0, 'and reveal no names or text');
reset role;

select pg_temp.login('dev3'); set local role authenticated;
select is((select array_agg(project_key || ':' || event_type order by event_type) from public.list_notifications(p_limit => 51)),
  array['NTB:PROJECT_MEMBER_ADDED', 'NTB:WORK_ITEM_ASSIGNED'], 'another project''s developer has only their own project''s notifications');
reset role;

-- -----------------------------------------------------------------------------
-- Reading and marking read
-- -----------------------------------------------------------------------------
select pg_temp.login('dev2'); set local role authenticated;
create temporary table t_dev2 on commit drop as select id, created_at from public.list_notifications(p_limit => 51);
select ok((select count(*) from t_dev2) >= 5, 'history');
select is((select array_agg(id order by created_at desc, id desc) from t_dev2), (select array_agg(id) from public.list_notifications(p_limit => 51)), 'newest first');
select is(public.notification_unread_count(), (select count(*)::int from public.list_notifications(p_status => 'unread', p_limit => 51)), 'unread count matches the unread filter');
select is((select array_agg(event_type order by event_type) from public.list_notifications(p_category => 'review_decision', p_limit => 51)),
  array['REVIEW_APPROVED', 'REVIEW_CHANGES_REQUESTED'], 'category filter');
select is((select count(*)::int from public.list_notifications(p_limit => 2)), 2, 'page size');
select is((select array_agg(id) from public.list_notifications(p_before_created_at => (select created_at from t_dev2 order by created_at desc, id desc limit 1), p_before_id => (select id from t_dev2 order by created_at desc, id desc limit 1), p_limit => 51)),
  (select array_agg(id order by created_at desc, id desc) from (select * from t_dev2 order by created_at desc, id desc offset 1) as rest), 'cursor continues without overlap');
select throws_ok($q$select * from public.list_notifications(p_status => 'archived')$q$, '22023', 'invalid_filter', 'status is allow-listed');
select throws_ok($q$select * from public.list_notifications(p_limit => 52)$q$, '22023', 'invalid_limit', 'page size is bounded');
reset role;

-- Marking someone else's notification read does nothing.
create temporary table t_pm_unread on commit drop as select id from public.notifications where recipient_id = pg_temp.uid('pm1') and read_at is null;
grant select on t_pm_unread to authenticated;
select pg_temp.login('dev2'); set local role authenticated;
select public.mark_notifications_read(array(select id from t_pm_unread));
reset role;
select is((select count(*)::int from public.notifications where id in (select id from t_pm_unread) and read_at is null), (select count(*)::int from t_pm_unread), 'others'' notifications cannot be marked read');
select pg_temp.login('dev2'); set local role authenticated;
select is((select count(*)::int from public.get_notifications(array(select id from t_pm_unread))), 0, 'nor read by id');
create temporary table t_marked on commit drop as select public.mark_notifications_read(array(select id from t_dev2 order by created_at desc limit 1)) as remaining;
select is((select remaining from t_marked), (select count(*)::int from public.list_notifications(p_status => 'unread', p_limit => 51)), 'mark one read returns the new unread count');
select ok((select read_at is not null from public.list_notifications(p_limit => 1)), 'the newest is now read');
select is(public.mark_all_notifications_read(), 0, 'mark all read');
select is(public.notification_unread_count(), 0, 'nothing unread');
reset role;
select ok((select count(*) from public.notifications where recipient_id = pg_temp.uid('pm1') and read_at is null) > 0, 'mark all read only touched the caller''s rows');

-- Inactive employees cannot read.
update public.profiles set is_active = false where id = pg_temp.uid('dev4');
select pg_temp.login('dev4'); set local role authenticated;
select throws_ok($q$select public.notification_unread_count()$q$, '42501', 'forbidden', 'inactive employees are refused');
reset role;

select * from finish();
rollback;
