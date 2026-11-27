-- Phase 8G2: work item comments, replies and mentions. Runs in a rolled-back transaction.
-- HTTP-level checks (sessions, concurrency) are in tests/integration/work-item-comments.local.mjs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures: SA; pm1 (project one), pm2 (project two); dev1 + dev2 + gone (inactive)
-- on project one; dev3 on project two; out (no project).
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',   '88000000-0000-4000-a000-000000000001'),
  ('pm1',  '88000000-0000-4000-a000-000000000002'),
  ('pm2',  '88000000-0000-4000-a000-000000000003'),
  ('dev1', '88000000-0000-4000-a000-000000000004'),
  ('dev2', '88000000-0000-4000-a000-000000000005'),
  ('dev3', '88000000-0000-4000-a000-000000000006'),
  ('out',  '88000000-0000-4000-a000-000000000007'),
  ('gone', '88000000-0000-4000-a000-000000000008');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8g2-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8G2 ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN' where id = '88000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('88000000-0000-4000-a000-000000000002', '88000000-0000-4000-a000-000000000003');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create function pg_temp.tok(p_key text) returns text language sql as $$ select '<@' || (select id from t_users where key = p_key) || '>' $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;
create function pg_temp.mentions(p_key text) returns text[] language sql as $$
  select coalesce(array_agg(t.key order by t.key), '{}') from public.work_item_comment_mentions m join t_users t on t.id = m.profile_id
   where m.comment_id = (select id from t_ids where key = p_key)
$$;
-- Comments created in one transaction share now(); give each its own time (as the table owner).
create function pg_temp.at_minute(p_key text, p_minute integer) returns void language sql as $$
  update public.work_item_comments set created_at = now() - interval '1 day' + p_minute * interval '1 minute'
   where id = (select id from t_ids where key = p_key)
$$;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8G2 One', 'CMA', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('gone'));
insert into t_ids values ('a', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Discussed task'));
insert into t_ids values ('epic', public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Discussed epic'));
insert into t_ids values ('old', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Archived task'));
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8G2 Two', 'CMB', 'medium'));
select public.add_project_member(pg_temp.id('p2'), pg_temp.uid('dev3'));
insert into t_ids values ('b', public.create_work_item(pg_temp.id('p2'), 'BUG', 'Other project bug'));
reset role;
update public.profiles set is_active = false where id = pg_temp.uid('gone');

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select has_table('public', 'work_item_comments', 'comments table');
select has_table('public', 'work_item_comment_mentions', 'mentions table');
select has_index('public', 'work_item_comments', 'work_item_comments_thread_idx', 'thread index');
select has_index('public', 'work_item_comments', 'work_item_comments_replies_idx', 'reply index');
select ok(not has_table_privilege('authenticated', 'public.work_item_comments', 'insert'), 'no direct inserts');
select ok(not has_table_privilege('authenticated', 'public.work_item_comments', 'update'), 'no direct updates');
select ok(not has_table_privilege('authenticated', 'public.work_item_comments', 'delete'), 'no direct deletes');
select ok(not has_table_privilege('authenticated', 'public.work_item_comment_mentions', 'select'), 'mentions only through RPCs');
select ok(not has_function_privilege('anon', 'public.create_work_item_comment(uuid,text,uuid)', 'execute'), 'anon cannot comment');
select ok(not has_function_privilege('authenticated', 'private.sync_comment_mentions(uuid,uuid,text)', 'execute'), 'mention sync is internal');
select ok(not has_function_privilege('authenticated', 'private.is_comment_mentionable(uuid,uuid)', 'execute'), 'eligibility helper is internal');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.create_work_item_comment(uuid,text,uuid)'::regprocedure), 'cyclo_project_api', 'implementation runs as the restricted API role');
select ok((select relrowsecurity from pg_class where oid = 'public.work_item_comments'::regclass), 'RLS on comments');
select ok((select relrowsecurity from pg_class where oid = 'public.work_item_comment_mentions'::regclass), 'RLS on mentions');

-- -----------------------------------------------------------------------------
-- Who may comment
-- -----------------------------------------------------------------------------
select pg_temp.login('sa'); set local role authenticated;
insert into t_ids select 'c_sa', id from public.create_work_item_comment(pg_temp.id('a'), 'Super Admin here');
reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids select 'c_pm', id from public.create_work_item_comment(pg_temp.id('a'), E'Assigned PM.\n\n  Indented second paragraph.');
insert into t_ids select 'c_epic', id from public.create_work_item_comment(pg_temp.id('epic'), 'Epics take comments too');
reset role; select pg_temp.login('dev1'); set local role authenticated;
insert into t_ids select 'c_dev', id from public.create_work_item_comment(pg_temp.id('a'), 'Member developer ' || pg_temp.tok('dev2') || ' ' || pg_temp.tok('pm1') || ' ' || pg_temp.tok('sa') || ' ' || pg_temp.tok('dev2'));
select is((select author_id from public.work_item_comments where id = pg_temp.id('c_dev')), pg_temp.uid('dev1'), 'author is the session user');
select is((select project_id from public.work_item_comments where id = pg_temp.id('c_dev')), pg_temp.id('p1'), 'project comes from the work item');
select is((select body from public.work_item_comments where id = pg_temp.id('c_pm')), E'Assigned PM.\n\n  Indented second paragraph.', 'multiline formatting is preserved');
reset role;

select pg_temp.login('dev3'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'hi')$q$, 'P0002', 'work_item_not_found', 'another project''s developer cannot comment');
select throws_ok($q$select * from public.list_work_item_comments(pg_temp.id('a'))$q$, 'P0002', 'work_item_not_found', 'nor read the discussion');
select is((select count(*)::int from public.work_item_comments where work_item_id = pg_temp.id('a')), 0, 'RLS hides other projects'' comments');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'hi')$q$, 'P0002', 'work_item_not_found', 'an unrelated PM cannot comment');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('b'), 'cross', pg_temp.id('c_pm'))$q$, '22023', 'invalid_parent_comment', 'a reply cannot cross items or projects');
reset role; select pg_temp.login('out'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'hi')$q$, 'P0002', 'work_item_not_found', 'a non-member cannot comment');
select throws_ok($q$select * from public.search_comment_mentions(pg_temp.id('a'), 'P8G2')$q$, 'P0002', 'work_item_not_found', 'a non-member cannot search mentions');
reset role; select pg_temp.login('gone'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'hi')$q$, '42501', 'forbidden', 'an inactive member cannot comment');
reset role;
select set_config('request.jwt.claims', '', true); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'hi')$q$, '42501', 'unauthenticated', 'anonymous sessions are refused');
select throws_ok($q$insert into public.work_item_comments (project_id, work_item_id, author_id, body) values (pg_temp.id('p1'), pg_temp.id('a'), pg_temp.uid('dev1'), 'x')$q$, '42501', null, 'direct inserts are refused');
reset role;

-- -----------------------------------------------------------------------------
-- Content validation
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), '')$q$, '22023', 'invalid_comment', 'empty');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), E'  \n\t ')$q$, '22023', 'invalid_comment', 'whitespace only');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), null)$q$, '22023', 'invalid_comment', 'null');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), repeat('x', 5001))$q$, '22023', 'invalid_comment', 'over 5000 characters');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), E'bell\x07')$q$, '22023', 'invalid_comment', 'control characters');
select lives_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), repeat('y', 5000))$q$, 'exactly 5000 characters');
select is((select body from public.create_work_item_comment(pg_temp.id('a'), E'  line one\r\nline two \r\n')), E'line one\nline two', 'trimmed and CRLF-normalised');
reset role;
select throws_ok($q$update public.work_item_comments set body = '' where id = pg_temp.id('c_dev')$q$, '23514', null, 'the table itself refuses invalid bodies');
select throws_ok($q$update public.work_item_comments set author_id = pg_temp.uid('dev2') where id = pg_temp.id('c_dev')$q$, '23514', 'comment_immutable', 'authorship is immutable');
select throws_ok($q$delete from public.work_item_comments where id = pg_temp.id('c_dev')$q$, '23514', null, 'comments are never hard-deleted');

-- -----------------------------------------------------------------------------
-- Mentions
-- -----------------------------------------------------------------------------
select is(pg_temp.mentions('c_dev'), array['dev2', 'pm1', 'sa'], 'multiple mentions; a repeated mention is stored once');
select pg_temp.login('dev1'); set local role authenticated;
select is((select jsonb_array_length(mentions) from public.list_work_item_comments(pg_temp.id('a')) where id = pg_temp.id('c_dev')), 3, 'mentions are returned with the comment');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'), 'hi ' || pg_temp.tok('dev3')), '22023', 'invalid_mention', 'another project''s developer cannot be mentioned');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'), 'hi ' || pg_temp.tok('pm2')), '22023', 'invalid_mention', 'another project''s PM cannot be mentioned');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'), 'hi ' || pg_temp.tok('out')), '22023', 'invalid_mention', 'a non-member cannot be mentioned');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'), 'hi ' || pg_temp.tok('gone')), '22023', 'invalid_mention', 'inactive employees cannot be mentioned');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'), 'hi <@' || gen_random_uuid() || '>'), '22023', 'invalid_mention', 'arbitrary ids are refused');
select throws_ok(format($q$select * from public.create_work_item_comment(%L, %L)$q$, pg_temp.id('a'),
  (select string_agg('<@' || gen_random_uuid() || '>', ' ') from generate_series(1, 21))), '22023', 'too_many_mentions', 'at most 20 people');
select is((select count(*)::int from public.work_item_comments where body like '%' || pg_temp.uid('dev3') || '%'), 0, 'a refused comment leaves nothing behind');
select set_eq($q$select full_name from public.search_comment_mentions(pg_temp.id('a'), 'P8G2', 20)$q$,
  array['P8G2 sa', 'P8G2 pm1', 'P8G2 dev1', 'P8G2 dev2'], 'mention search: SA, assigned PM and active members only');
select is((select full_name from public.search_comment_mentions(pg_temp.id('a'), 'P8G2', 20) limit 1), 'P8G2 pm1', 'the project''s PM is listed first');
select is((select array_agg(full_name) from public.search_comment_mentions(pg_temp.id('a'), 'dev2')), array['P8G2 dev2'], 'mention search filters by name');
select is((select count(*)::int from public.search_comment_mentions(pg_temp.id('a'), '%')), 0, 'search wildcards are literal');
select throws_ok($q$select * from public.search_comment_mentions(pg_temp.id('a'), 'x', 21)$q$, '22023', 'invalid_limit', 'search is bounded');
reset role;

-- -----------------------------------------------------------------------------
-- Replies
-- -----------------------------------------------------------------------------
select pg_temp.login('dev2'); set local role authenticated;
insert into t_ids select 'r1', id from public.create_work_item_comment(pg_temp.id('a'), 'First reply', pg_temp.id('c_pm'));
insert into t_ids select 'r2', id from public.create_work_item_comment(pg_temp.id('a'), 'Second reply', pg_temp.id('c_pm'));
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'nested', pg_temp.id('r1'))$q$, '22023', 'invalid_parent_comment', 'replies are one level deep');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('epic'), 'wrong item', pg_temp.id('c_pm'))$q$, '22023', 'invalid_parent_comment', 'a reply stays on its work item');
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'ghost', gen_random_uuid())$q$, '22023', 'invalid_parent_comment', 'unknown parent');
reset role;

-- Chronology: c_sa, c_pm, c_dev, then the long/normalised comments; replies r1 < r2.
-- created_at is immutable through the guard; the fixture re-dates rows as the owner with it off.
alter table public.work_item_comments disable trigger work_item_comments_guard_row;
select pg_temp.at_minute('c_sa', 1); select pg_temp.at_minute('c_pm', 2); select pg_temp.at_minute('c_dev', 3);
select pg_temp.at_minute('r1', 10); select pg_temp.at_minute('r2', 11);
update public.work_item_comments set created_at = now() - interval '1 day' + interval '20 minutes'
 where work_item_id = pg_temp.id('a') and id not in (select id from t_ids);
alter table public.work_item_comments enable always trigger work_item_comments_guard_row;
select throws_ok($q$update public.work_item_comments set created_at = now() where id = pg_temp.id('c_sa')$q$, '23514', 'comment_immutable', 'created_at is immutable');

select pg_temp.login('pm1'); set local role authenticated;
create temporary table t_list on commit drop as
  select row_number() over () as n, id, parent_comment_id, reply_count from public.list_work_item_comments(pg_temp.id('a'));
select is((select array_agg(id order by n) from t_list where n <= 5),
  array[pg_temp.id('c_sa'), pg_temp.id('c_pm'), pg_temp.id('r1'), pg_temp.id('r2'), pg_temp.id('c_dev')], 'oldest first; replies follow their thread in order');
select is((select reply_count from t_list where id = pg_temp.id('c_pm')), 2, 'reply count');
select is((select count(*)::int from t_list where parent_comment_id is null), 5, 'five threads');

-- Pagination
select is((select array_agg(id) from public.list_work_item_comments(pg_temp.id('a'), p_limit => 2, p_reply_limit => 0)),
  array[pg_temp.id('c_sa'), pg_temp.id('c_pm')], 'page 1 (threads only)');
select is((select array_agg(id) from public.list_work_item_comments(pg_temp.id('a'), (select created_at from public.work_item_comments where id = pg_temp.id('c_pm')), pg_temp.id('c_pm'), 2, 1)),
  array[pg_temp.id('c_dev'), (select id from public.work_item_comments where work_item_id = pg_temp.id('a') and created_at = now() - interval '1 day' + interval '20 minutes' order by id limit 1)],
  'page 2 continues after the cursor');
select is((select array_agg(id) from public.list_work_item_comments(pg_temp.id('a'), p_limit => 2, p_reply_limit => 1) where parent_comment_id is not null), array[pg_temp.id('r1')], 'reply preview is bounded');
select is((select array_agg(id) from public.list_comment_replies(pg_temp.id('c_pm'), (select created_at from public.work_item_comments where id = pg_temp.id('r1')), pg_temp.id('r1'), 10)),
  array[pg_temp.id('r2')], 'more replies after the cursor');
select throws_ok($q$select * from public.list_work_item_comments(pg_temp.id('a'), p_limit => 52)$q$, '22023', 'invalid_limit', 'page size is bounded');
select throws_ok($q$select * from public.list_work_item_comments(pg_temp.id('a'), now(), null)$q$, '22023', 'invalid_cursor', 'cursor needs both parts');
reset role;

-- -----------------------------------------------------------------------------
-- Edit and delete: author only
-- -----------------------------------------------------------------------------
select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.update_work_item_comment(pg_temp.id('c_dev'), 'hijack')$q$, '42501', 'forbidden', 'another member cannot edit');
select throws_ok($q$select * from public.delete_work_item_comment(pg_temp.id('c_dev'))$q$, '42501', 'forbidden', 'another member cannot delete');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select * from public.update_work_item_comment(pg_temp.id('c_dev'), 'moderated')$q$, '42501', 'forbidden', 'the PM cannot edit someone else''s comment');
reset role; select pg_temp.login('sa'); set local role authenticated;
select throws_ok($q$select * from public.delete_work_item_comment(pg_temp.id('c_dev'))$q$, '42501', 'forbidden', 'the Super Admin cannot delete someone else''s comment');
reset role;

-- The surviving mention rows keep their creation time across an edit (new vs old mentions).
update public.work_item_comment_mentions set created_at = now() - interval '1 hour' where comment_id = pg_temp.id('c_dev');
select pg_temp.login('dev1'); set local role authenticated;
select is((select edited_at from public.update_work_item_comment(pg_temp.id('c_dev'), (select body from public.work_item_comments where id = pg_temp.id('c_dev')))), null, 'saving unchanged text is not an edit');
select ok((select edited_at is not null from public.update_work_item_comment(pg_temp.id('c_dev'), 'Updated ' || pg_temp.tok('pm1') || ' and ' || pg_temp.tok('dev1'))), 'author edits: edited_at set');
reset role;
select is(pg_temp.mentions('c_dev'), array['dev1', 'pm1'], 'mentions follow the edit');
select ok((select created_at < now() - interval '30 minutes' from public.work_item_comment_mentions where comment_id = pg_temp.id('c_dev') and profile_id = pg_temp.uid('pm1')), 'a kept mention is not re-created');
select ok((select created_at = now() from public.work_item_comment_mentions where comment_id = pg_temp.id('c_dev') and profile_id = pg_temp.uid('dev1')), 'a new mention is new');

select pg_temp.login('pm1'); set local role authenticated;
select is((select row(body, deleted_at is not null) from public.delete_work_item_comment(pg_temp.id('c_pm'))), row(null::text, true), 'author deletes: body removed');
select is((select deleted_at is not null from public.delete_work_item_comment(pg_temp.id('c_pm'))), true, 'deleting again is a no-op');
select throws_ok($q$select * from public.update_work_item_comment(pg_temp.id('c_pm'), 'back')$q$, '55000', 'comment_deleted', 'a deleted comment cannot be edited');
select is((select row(body, deleted_at is not null, reply_count) from public.list_work_item_comments(pg_temp.id('a')) where id = pg_temp.id('c_pm')),
  row(null::text, true, 2), 'a deleted comment with replies stays as a placeholder');
select ok(not exists (select 1 from public.list_work_item_comments(pg_temp.id('a')) where body is null and reply_count = 0), 'nothing else deleted is listed');
reset role;
select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('a'), 'late reply', pg_temp.id('c_pm'))$q$, '55000', 'comment_deleted', 'no new replies to a deleted comment');
select * from public.delete_work_item_comment(pg_temp.id('r1'));
select * from public.delete_work_item_comment(pg_temp.id('r2'));
select ok(not exists (select 1 from public.list_work_item_comments(pg_temp.id('a')) where id in (pg_temp.id('c_pm'), pg_temp.id('r1'), pg_temp.id('r2'))), 'a deleted thread without replies disappears');
reset role;
select pg_temp.login('dev1'); set local role authenticated;
select * from public.delete_work_item_comment(pg_temp.id('c_dev'));
reset role;
select is(pg_temp.mentions('c_dev'), '{}'::text[], 'deleting removes the mentions');

-- A developer removed from the team loses edit rights on their own comments.
select pg_temp.login('pm1'); set local role authenticated;
select public.remove_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
insert into t_ids select 'c_dev1b', id from public.create_work_item_comment(pg_temp.id('a'), 'still here');
reset role; select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.list_work_item_comments(pg_temp.id('a'))$q$, 'P0002', 'work_item_not_found', 'a removed member can no longer read');
reset role;

-- Archived work is read-only.
select pg_temp.login('pm1'); set local role authenticated;
select public.archive_work_item(pg_temp.id('old'));
select throws_ok($q$select * from public.create_work_item_comment(pg_temp.id('old'), 'too late')$q$, '55000', 'work_item_archived', 'archived items take no comments');
select is((select count(*)::int from public.list_work_item_comments(pg_temp.id('old'))), 0, 'but can still be read');
reset role;

-- -----------------------------------------------------------------------------
-- Audit and activity
-- -----------------------------------------------------------------------------
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action = 'WORK_ITEM_COMMENT_ADDED'), 9, 'one event per comment');
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action = 'WORK_ITEM_COMMENT_EDITED'), 1, 'one event per real edit');
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action = 'WORK_ITEM_COMMENT_DELETED'), 4, 'one event per deletion (not per retry)');
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action like 'WORK_ITEM_COMMENT_%'
            and (new_values ? 'body' or old_values ? 'body' or new_values::text like '%Member developer%')), 0, 'no comment text in the audit log');
select is((select new_values ->> 'mentions' from private.project_audit_log where action = 'WORK_ITEM_COMMENT_ADDED' and new_values ->> 'comment_id' = pg_temp.id('c_dev')::text), '3', 'the audit records the mention count');
select pg_temp.login('dev1'); set local role authenticated;
select ok((select count(*) from public.list_project_activity(pg_temp.id('p1'), null, null, 100, pg_temp.id('a')) where action = 'WORK_ITEM_COMMENT_ADDED') > 0, 'comment events reach the item history');
reset role;

select * from finish();
rollback;
