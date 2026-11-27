-- Phase 8G1: Review Inbox (list_review_queue, review_queue_summary) and review
-- decisions through execute_work_item. Runs in a rolled-back transaction.
-- Concurrent decisions over HTTP are covered in tests/integration/review-inbox.local.mjs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures: SA, two PMs (one project each), an inactive PM, two developers.
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',   '87000000-0000-4000-a000-000000000001'),
  ('pm1',  '87000000-0000-4000-a000-000000000002'),
  ('pm2',  '87000000-0000-4000-a000-000000000003'),
  ('dev1', '87000000-0000-4000-a000-000000000004'),
  ('dev2', '87000000-0000-4000-a000-000000000005'),
  ('gone', '87000000-0000-4000-a000-000000000006');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8g1-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8G1 ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN' where id = '87000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('87000000-0000-4000-a000-000000000002', '87000000-0000-4000-a000-000000000003', '87000000-0000-4000-a000-000000000006');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;
create function pg_temp.status(p_key text) returns text language sql as $$ select status::text from public.work_items where id = (select id from t_ids where key = p_key) $$;
-- Keys of this test's fixtures (RVA/RVB/RVC) in queue order. The local database
-- may hold other data, which a Super Admin also sees; this keeps assertions exact.
create function pg_temp.fixture_keys(p_keys text[]) returns text[] language sql as $$
  select coalesce(array_agg(k.key order by k.ord), '{}') from unnest(p_keys) with ordinality as k(key, ord)
   where k.key ~ '^RV[ABC]-[0-9]+$'
$$;
create function pg_temp.queue_keys() returns text[] language sql as $$
  select pg_temp.fixture_keys(array(select issue_key from public.list_review_queue(p_page_size => 100)))
$$;

-- Project One (pm1): A (dev1, high), B (dev2, low), C (unassigned, critical) in review;
-- D in progress, E to do, F archived after review.
reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8G1 One', 'RVA', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
insert into t_ids values ('a', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Alpha checkout flow', p_status => 'TODO', p_priority => 'high', p_assignee_id => pg_temp.uid('dev1')));
insert into t_ids values ('b', public.create_work_item(pg_temp.id('p1'), 'BUG', 'Bravo login bug', p_status => 'TODO', p_priority => 'low', p_assignee_id => pg_temp.uid('dev2')));
insert into t_ids values ('c', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Charlie unassigned', p_status => 'TODO', p_priority => 'critical'));
insert into t_ids values ('d', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Delta in progress', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1')));
insert into t_ids values ('e', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Echo to do', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1')));
insert into t_ids values ('f', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Foxtrot archived', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1')));
reset role;

-- Developers submit their work; the manager drives unassigned C and archived F.
select pg_temp.login('dev1'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('a'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'IN_PROGRESS');
select * from public.execute_work_item(pg_temp.id('d'), 'start', 'TODO');
reset role; select pg_temp.login('dev2'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('b'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('b'), 'submit_review', 'IN_PROGRESS');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('c'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('c'), 'submit_review', 'IN_PROGRESS');
select * from public.execute_work_item(pg_temp.id('f'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('f'), 'submit_review', 'IN_PROGRESS');
select public.archive_work_item(pg_temp.id('f'));
reset role;

-- Project Two (pm2): G (dev2) in review. Project Three (pm2, archived): H in review.
select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8G1 Two', 'RVB', 'medium'));
select public.add_project_member(pg_temp.id('p2'), pg_temp.uid('dev2'));
insert into t_ids values ('g', public.create_work_item(pg_temp.id('p2'), 'TASK', 'Golf other project', p_status => 'TODO', p_priority => 'medium', p_assignee_id => pg_temp.uid('dev2')));
select * from public.execute_work_item(pg_temp.id('g'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('g'), 'submit_review', 'IN_PROGRESS');
insert into t_ids values ('p3', public.create_project('P8G1 Three', 'RVC', 'medium'));
insert into t_ids values ('h', public.create_work_item(pg_temp.id('p3'), 'TASK', 'Hotel archived project', p_status => 'TODO'));
select * from public.execute_work_item(pg_temp.id('h'), 'start', 'TODO');
select * from public.execute_work_item(pg_temp.id('h'), 'submit_review', 'IN_PROGRESS');
select public.archive_project(pg_temp.id('p3'));
reset role;

-- Every event in this transaction shares now(): date the submissions (as the table owner).
-- A: 5 days ago, B: 2 days ago, C: 2 hours ago, G: 4 days ago.
update private.project_audit_log set created_at = now() - interval '5 days'
 where work_item_id = pg_temp.id('a') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW';
update private.project_audit_log set created_at = now() - interval '2 days'
 where work_item_id = pg_temp.id('b') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW';
update private.project_audit_log set created_at = now() - interval '2 hours'
 where work_item_id = pg_temp.id('c') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW';
update private.project_audit_log set created_at = now() - interval '4 days'
 where work_item_id = pg_temp.id('g') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW';

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.list_review_queue(text,uuid,uuid,boolean,public.project_priority,integer,text,integer,integer)', 'execute'), 'anon cannot read the queue');
select ok(not has_function_privilege('anon', 'public.review_queue_summary()', 'execute'), 'anon cannot read the summary');
select ok(not has_function_privilege('authenticated', 'private.review_actor()', 'execute'), 'the access helper is internal');
select is((select prosecdef from pg_proc where oid = 'public.list_review_queue(text,uuid,uuid,boolean,public.project_priority,integer,text,integer,integer)'::regprocedure), false, 'public wrapper is SECURITY INVOKER');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'private.list_review_queue(text,uuid,uuid,boolean,public.project_priority,integer,text,integer,integer)'::regprocedure), 'cyclo_project_api', 'implementation runs as the restricted API role');
select has_index('public', 'work_items', 'work_items_in_review_idx', 'in-review partial index');
select has_index('private', 'project_audit_log', 'project_audit_log_submitted_idx', 'submission event index');

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select * from public.list_review_queue()$q$, '42501', 'forbidden', 'developers cannot open the inbox');
select throws_ok($q$select * from public.review_queue_summary()$q$, '42501', 'forbidden', 'developers cannot read review counts');
reset role;
update public.profiles set is_active = false where id = pg_temp.uid('gone');
select pg_temp.login('gone'); set local role authenticated;
select throws_ok($q$select * from public.list_review_queue()$q$, '42501', 'forbidden', 'inactive managers are refused');
reset role;
select set_config('request.jwt.claims', '', true); set local role authenticated;
select throws_ok($q$select * from public.list_review_queue()$q$, '42501', 'unauthenticated', 'anonymous sessions are refused');
reset role;

-- -----------------------------------------------------------------------------
-- Scope and content
-- -----------------------------------------------------------------------------
select pg_temp.login('sa'); set local role authenticated;
select is(pg_temp.queue_keys(), array['RVA-1', 'RVB-1', 'RVA-2', 'RVA-3'], 'SA: every project, IN_REVIEW only, oldest first (archived items/projects excluded)');
select is((select count(*)::int from public.review_queue_summary() where scope = 'project' and id in (pg_temp.id('p1'), pg_temp.id('p2'), pg_temp.id('p3'))), 2, 'SA summary: both active projects, not the archived one');
select is((select pending_count from public.review_queue_summary() where scope = 'project' and id = pg_temp.id('p1')), 3, 'SA summary: three in project one');
select is((select pending_count from public.review_queue_summary() where scope = 'project' and id = pg_temp.id('p2')), 1, 'SA summary: one in project two');
reset role;

select pg_temp.login('pm1'); set local role authenticated;
select is((select array_agg(issue_key) from public.list_review_queue()), array['RVA-1', 'RVA-2', 'RVA-3'], 'PM: assigned project only (nothing else at all)');
select is((select total_count from public.list_review_queue() limit 1), 3::bigint, 'PM: total count');
select is((select count(*)::int from public.list_review_queue(p_project_id => pg_temp.id('p2'))), 0, 'PM: another project''s id yields nothing');
select is((select count(*)::int from public.list_review_queue(p_search => 'RVB-1')), 0, 'PM: another project''s key yields nothing');
select set_eq($q$select scope || ':' || coalesce(label, '-') || ':' || pending_count from public.review_queue_summary()$q$,
  array['project:P8G1 One:3', 'assignee:P8G1 dev1:1', 'assignee:P8G1 dev2:1', 'assignee:-:1'], 'PM summary: own project, per assignee (unassigned included)');
select is((select row(project_name, project_key, assignee_name, type::text, priority::text)
             from public.list_review_queue() where issue_key = 'RVA-1'),
          row('P8G1 One'::text, 'RVA'::text, 'P8G1 dev1'::text, 'TASK'::text, 'high'::text), 'row carries project, assignee (name only) and priority');
select ok((select submitted_at between now() - interval '5 days 1 minute' and now() - interval '4 days 23 hours' from public.list_review_queue() where issue_key = 'RVA-1'), 'submitted_at is the submission event time');
reset role;

select pg_temp.login('pm2'); set local role authenticated;
select is((select array_agg(issue_key) from public.list_review_queue()), array['RVB-1'], 'PM two: own active project only (archived project excluded)');
reset role;

-- -----------------------------------------------------------------------------
-- Filters and sorting (as SA, across projects; other local data filtered out)
-- -----------------------------------------------------------------------------
select pg_temp.login('sa'); set local role authenticated;
create function pg_temp.sa_keys(p_assignee uuid default null, p_unassigned boolean default false, p_priority public.project_priority default null,
                                p_age integer default null, p_search text default null, p_sort text default 'oldest', p_project uuid default null)
returns text[] language sql as $$
  select pg_temp.fixture_keys(array(select issue_key from public.list_review_queue(
    p_search => p_search, p_project_id => p_project, p_assignee_id => p_assignee, p_unassigned => p_unassigned,
    p_priority => p_priority, p_min_age_days => p_age, p_sort => p_sort, p_page_size => 100)))
$$;
select is(pg_temp.sa_keys(p_project => pg_temp.id('p1')), array['RVA-1', 'RVA-2', 'RVA-3'], 'filter: project');
select is((select count(*)::int from public.list_review_queue(p_project_id => pg_temp.id('p1'))), 3, 'filter: project returns that project only');
select is(pg_temp.sa_keys(p_assignee => pg_temp.uid('dev2')), array['RVB-1', 'RVA-2'], 'filter: assignee (across projects)');
select is((select count(*)::int from public.list_review_queue(p_assignee_id => pg_temp.uid('dev2'))), 2, 'filter: assignee returns their work only');
select is(pg_temp.sa_keys(p_unassigned => true), array['RVA-3'], 'filter: unassigned');
select is(pg_temp.sa_keys(p_priority => 'critical'), array['RVA-3'], 'filter: priority');
select is(pg_temp.sa_keys(p_age => 3), array['RVA-1', 'RVB-1'], 'filter: waiting 3+ days');
select is(pg_temp.sa_keys(p_age => 1), array['RVA-1', 'RVB-1', 'RVA-2'], 'filter: waiting 1+ day');
select is((select array_agg(issue_key) from public.list_review_queue(p_search => 'rva-2')), array['RVA-2'], 'search: exact key (case-insensitive)');
select is(pg_temp.sa_keys(p_search => 'Bravo login'), array['RVA-2'], 'search: title');
select is(pg_temp.sa_keys(p_search => '%'), '{}'::text[], 'search: wildcards are literal');
select is(pg_temp.sa_keys(p_sort => 'newest'), array['RVA-3', 'RVA-2', 'RVB-1', 'RVA-1'], 'sort: newest');
select is(pg_temp.sa_keys(p_sort => 'priority'), array['RVA-3', 'RVA-1', 'RVB-1', 'RVA-2'], 'sort: priority, then oldest');
reset role;

-- Pagination (as pm1: an exact, isolated scope of three items)
select pg_temp.login('pm1'); set local role authenticated;
select is((select array_agg(issue_key) from public.list_review_queue(p_page => 1, p_page_size => 2)), array['RVA-1', 'RVA-2'], 'page 1');
select is((select array_agg(issue_key) from public.list_review_queue(p_page => 2, p_page_size => 2)), array['RVA-3'], 'page 2 continues without overlap');
select is((select total_count from public.list_review_queue(p_page => 2, p_page_size => 2)), 3::bigint, 'total count is the full match count');
select is((select count(*)::int from public.list_review_queue(p_page => 3, p_page_size => 2)), 0, 'past the end: empty');
reset role;

select pg_temp.login('sa'); set local role authenticated;
select throws_ok($q$select * from public.list_review_queue(p_page_size => 101)$q$, '22023', 'invalid_page_size', 'page size is bounded');
select throws_ok($q$select * from public.list_review_queue(p_page => 0)$q$, '22023', 'invalid_page', 'page is bounded');
select throws_ok($q$select * from public.list_review_queue(p_sort => 'updated')$q$, '22023', 'invalid_sort', 'sort is allow-listed');
select throws_ok($q$select * from public.list_review_queue(p_min_age_days => -1)$q$, '22023', 'invalid_filter', 'age is bounded');
select throws_ok($q$select * from public.list_review_queue(p_assignee_id => pg_temp.uid('dev1'), p_unassigned => true)$q$, '22023', 'invalid_filter', 'assignee and unassigned are exclusive');
select throws_ok($q$select * from public.list_review_queue(p_search => repeat('x', 101))$q$, '22023', 'invalid_search', 'search is bounded');
reset role;

-- -----------------------------------------------------------------------------
-- Decisions (existing execute_work_item)
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')$q$, '42501', 'forbidden', 'a developer cannot approve their own work');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')$q$, 'P0002', 'work_item_not_found', 'a PM cannot decide another project''s review');
reset role;

select pg_temp.login('pm1'); set local role authenticated;
select is((select row(status::text, changed) from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')), row('DONE'::text, true), 'approve: IN_REVIEW -> DONE');
select is((select changed from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')), false, 'duplicate approve is a no-op');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'reject', 'IN_REVIEW', 'Too late')$q$, '55000', 'status_changed', 'stale decision on an approved item is refused');
select ok(not ('RVA-1' = any (pg_temp.queue_keys())), 'approved work leaves the queue');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'reject', 'IN_REVIEW')$q$, '22023', 'reason_required', 'request changes requires a reason');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'reject', 'IN_REVIEW', '  x ')$q$, '22023', 'reason_required', 'the reason must be meaningful');
select is((select status::text from public.execute_work_item(pg_temp.id('b'), 'reject', 'IN_REVIEW', 'Handle the expired-token case')), 'IN_PROGRESS', 'request changes: IN_REVIEW -> IN_PROGRESS');
select is((select changed from public.execute_work_item(pg_temp.id('b'), 'reject', 'IN_REVIEW', 'Handle the expired-token case')), false, 'duplicate request-changes is a no-op');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'approve', 'IN_REVIEW')$q$, '55000', 'status_changed', 'stale approve after a rejection is refused');
select is(pg_temp.status('b'), 'IN_PROGRESS', 'the rejection stands');
select is(pg_temp.queue_keys(), array['RVA-3'], 'decided work leaves the queue');
select is((select pending_count from public.review_queue_summary() where scope = 'project'), 1, 'counts follow');
reset role;

select is((select new_values ->> 'reason' from private.project_audit_log
            where work_item_id = pg_temp.id('b') and action = 'WORK_ITEM_REVIEW_REJECTED'), 'Handle the expired-token case', 'the reason is in the audit log');
select is((select count(*)::int from private.project_audit_log where work_item_id = pg_temp.id('a') and action = 'WORK_ITEM_REVIEW_APPROVED'), 1, 'one approval event despite the retry');
select is((select count(*)::int from private.project_audit_log where work_item_id = pg_temp.id('b') and action = 'WORK_ITEM_REVIEW_REJECTED'), 1, 'one rejection event despite the retry');

-- Resubmission re-enters the queue with the new submission time.
select pg_temp.login('dev2'); set local role authenticated;
select * from public.execute_work_item(pg_temp.id('b'), 'submit_review', 'IN_PROGRESS');
reset role;
update private.project_audit_log set created_at = now() - interval '1 hour'
 where work_item_id = pg_temp.id('b') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW'
   and created_at = (select max(created_at) from private.project_audit_log where work_item_id = pg_temp.id('b') and action = 'WORK_ITEM_SUBMITTED_FOR_REVIEW');
select pg_temp.login('pm1'); set local role authenticated;
select is(pg_temp.queue_keys(), array['RVA-3', 'RVA-2'], 'resubmitted work returns, dated by its latest submission');
reset role;

select * from finish();
rollback;
