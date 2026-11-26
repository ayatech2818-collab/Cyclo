-- Phase 8F1: sprints (CRUD, dates, eligibility, add/remove/move, lifecycle,
-- carry-over, capacity, permissions, RLS, audit, pagination).
-- Concurrent starts are exercised over HTTP in tests/integration/sprints.local.mjs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',   '85000000-0000-4000-a000-000000000001'),
  ('pm1',  '85000000-0000-4000-a000-000000000002'),
  ('pm2',  '85000000-0000-4000-a000-000000000003'),
  ('dev1', '85000000-0000-4000-a000-000000000004'),
  ('dev2', '85000000-0000-4000-a000-000000000005');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8f-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8F ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN' where id = '85000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('85000000-0000-4000-a000-000000000002', '85000000-0000-4000-a000-000000000003');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8F One', 'SPK', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
insert into t_ids values ('epic', public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Epic'));
insert into t_ids values ('story', public.create_work_item(pg_temp.id('p1'), 'STORY', 'Story', p_parent_id => pg_temp.id('epic'), p_estimate => 5, p_description => 'Secret story text'));
insert into t_ids values ('t1', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Task one', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1'), p_estimate => 8));
insert into t_ids values ('t2', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Task two', p_assignee_id => pg_temp.uid('dev1'), p_estimate => 2));
insert into t_ids values ('bug', public.create_work_item(pg_temp.id('p1'), 'BUG', 'Bug'));
insert into t_ids values ('sub', public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Subtask', p_parent_id => pg_temp.id('t1')));
insert into t_ids values ('done', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Already done', p_status => 'TODO'));
insert into t_ids values ('arch', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Archived'));
select public.change_work_item_status(pg_temp.id('done'), 'IN_PROGRESS');
select public.change_work_item_status(pg_temp.id('done'), 'IN_REVIEW');
select public.change_work_item_status(pg_temp.id('done'), 'DONE');
select public.archive_work_item(pg_temp.id('arch'));
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8F Two', 'SPL', 'medium'));
insert into t_ids values ('x', public.create_work_item(pg_temp.id('p2'), 'TASK', 'Elsewhere'));
insert into t_ids values ('xs', public.create_sprint(pg_temp.id('p2'), 'Other sprint'));
reset role;

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select has_table('public', 'sprints', 'sprints table');
select has_index('public', 'sprints', 'sprints_one_active_per_project', 'one active sprint per project (partial unique index)');
select has_column('public', 'work_items', 'sprint_id', 'work items reference at most one sprint');
select ok(not has_table_privilege('authenticated', 'public.sprints', 'insert'), 'no direct INSERT');
select ok(not has_table_privilege('authenticated', 'public.sprints', 'update'), 'no direct UPDATE');
select ok(not has_table_privilege('service_role', 'public.sprints', 'delete'), 'no DELETE even for service_role');
select ok(not has_column_privilege('authenticated', 'public.work_items', 'sprint_id', 'update'), 'no direct membership writes');
select ok(not has_function_privilege('anon', 'public.start_sprint(uuid)', 'execute'), 'anon cannot start sprints');

-- -----------------------------------------------------------------------------
-- Create / update / validation
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$insert into t_ids values ('s1', public.create_sprint(pg_temp.id('p1'), '  Sprint 1 ', 'Ship checkout', '2027-01-04', '2027-01-18', 10))$q$, 'PM creates a sprint');
select lives_ok($q$insert into t_ids values ('s2', public.create_sprint(pg_temp.id('p1'), 'Sprint 2'))$q$, 'planned sprint without dates');
select lives_ok($q$insert into t_ids values ('s3', public.create_sprint(pg_temp.id('p1'), 'Sprint 3', null, '2027-02-01', '2027-02-14'))$q$, 'several planned sprints are allowed');
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), '  ')$q$, '22023', 'invalid_sprint_name', 'name required');
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), repeat('x', 81))$q$, '22023', 'invalid_sprint_name', 'name length');
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), 'Bad', null, '2027-01-10', '2027-01-10')$q$, '22023', 'invalid_sprint_dates', 'start must be before end');
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), 'Bad', null, '2027-01-10', '2027-01-01')$q$, '22023', 'invalid_sprint_dates', 'start after end rejected');
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), 'Bad', null, null, null, -1)$q$, '22023', 'invalid_capacity', 'capacity is non-negative');
select lives_ok($q$select public.update_sprint(pg_temp.id('s2'), 'Sprint 2', 'Search', '2027-01-18', '2027-02-01')$q$, 'update a planned sprint');
reset role;
select is((select row(name, status::text, created_by) from public.sprints where id = pg_temp.id('s1')), row('Sprint 1'::text, 'PLANNING'::text, pg_temp.uid('pm1')), 'name trimmed, starts PLANNING, creator from session');
select throws_ok($q$delete from public.sprints where id = pg_temp.id('s1')$q$, '23514', 'Sprints cannot be deleted. Cancel or complete the sprint instead.', 'sprints are never deleted');

select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), 'Dev sprint')$q$, '42501', 'forbidden', 'developers cannot create sprints');
select throws_ok($q$select public.update_sprint(pg_temp.id('s1'), 'Hijack')$q$, '42501', 'forbidden', 'developers cannot edit sprints');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select public.create_sprint(pg_temp.id('p1'), 'Intrude')$q$, 'P0002', 'project_not_found', 'other PM cannot create');
select throws_ok($q$select public.update_sprint(pg_temp.id('s1'), 'Intrude')$q$, 'P0002', 'sprint_not_found', 'other PM cannot edit');

-- -----------------------------------------------------------------------------
-- Eligibility and membership
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select is(public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('story'), pg_temp.id('t1'), pg_temp.id('bug')]), 3, 'add stories, tasks and bugs');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('epic')])$q$, '22023', 'not_schedulable', 'epics are not scheduled');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('sub')])$q$, '22023', 'not_schedulable', 'subtasks travel with their task');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('done')])$q$, '22023', 'not_schedulable', 'done items cannot be added');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('arch')])$q$, '22023', 'not_schedulable', 'archived items cannot be added');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('x')])$q$, '22023', 'invalid_selection', 'items from another project rejected');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('t1')])$q$, '23505', 'already_in_sprint', 'no duplicate membership');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s2'), array[pg_temp.id('t1')])$q$, '22023', 'in_another_sprint', 'at most one sprint per item');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('t2'), pg_temp.id('t2')])$q$, '22023', 'invalid_selection', 'duplicate ids rejected');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('t2'), pg_temp.id('epic')])$q$, '22023', 'not_schedulable', 'mixed batch fails as a whole');
select is((select sprint_id from public.work_items where id = pg_temp.id('t2')), null, '... and adds nothing');
reset role;
select throws_ok($q$update public.work_items set sprint_id = pg_temp.id('xs') where id = pg_temp.id('t2')$q$, '22023', 'invalid_sprint_id', 'cross-project sprint rejected for every writer');
select throws_ok($q$update public.work_items set type = 'EPIC', parent_id = null where id = pg_temp.id('bug')$q$, '22023', 'not_schedulable', 'a scheduled item cannot become an epic');
select is((select row(status::text, assignee_id) from public.work_items where id = pg_temp.id('t1')), row('TODO'::text, pg_temp.uid('dev1')), 'adding keeps status and assignee');

select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('t2')])$q$, '42501', 'forbidden', 'developers cannot add items');
select throws_ok($q$select public.remove_work_items_from_sprint(pg_temp.id('s1'), array[pg_temp.id('t1')])$q$, '42501', 'forbidden', 'developers cannot remove items');
select ok(not exists (select 1 from public.list_backlog(pg_temp.id('p1')) where id in (pg_temp.id('story'), pg_temp.id('t1'), pg_temp.id('bug'))), 'sprint items leave the backlog');
select ok(exists (select 1 from public.list_backlog(pg_temp.id('p1')) where id = pg_temp.id('t2')), 'unscheduled items stay in the backlog');

-- -----------------------------------------------------------------------------
-- Capacity
-- -----------------------------------------------------------------------------
create temporary table t_cap on commit drop as select * from public.sprint_capacity(pg_temp.id('s1'));
create temporary table t_s1 on commit drop as select * from public.get_sprint(pg_temp.id('s1'));
reset role;
select is((select row(item_count, estimate_total, unestimated_count, capacity_points) from t_s1), row(3, 13::numeric, 1, 10::numeric), 'sprint totals: items, points, unestimated, capacity');
select ok((select estimate_total > capacity_points from t_s1), 'over capacity is detectable (13 > 10)');
select is((select row(item_count, estimate_total) from t_cap where assignee_id = pg_temp.uid('dev1')), row(1, 8::numeric), 'points per developer');
select is((select row(item_count, estimate_total, unestimated_count) from t_cap where assignee_id is null), row(2, 5::numeric, 1), 'unassigned work');

-- -----------------------------------------------------------------------------
-- Move and remove
-- -----------------------------------------------------------------------------
select pg_temp.login('pm1'); set local role authenticated;
select is(public.move_work_items_between_sprints(pg_temp.id('s1'), pg_temp.id('s2'), array[pg_temp.id('bug')]), 1, 'move a bug to another planned sprint');
select throws_ok($q$select public.move_work_items_between_sprints(pg_temp.id('s1'), pg_temp.id('s2'), array[pg_temp.id('t2')])$q$, '22023', 'not_in_sprint', 'only items of the source sprint move');
select throws_ok($q$select public.move_work_items_between_sprints(pg_temp.id('s1'), pg_temp.id('xs'), array[pg_temp.id('story')])$q$, 'P0002', 'sprint_not_found', 'cannot move into another project''s sprint');
select is(public.remove_work_items_from_sprint(pg_temp.id('s1'), array[pg_temp.id('story')]), 1, 'remove returns an item to the backlog');
select throws_ok($q$select public.remove_work_items_from_sprint(pg_temp.id('s1'), array[pg_temp.id('story')])$q$, '22023', 'not_in_sprint', 'removing a non-member fails');
select is(public.add_work_items_to_sprint(pg_temp.id('s1'), array[pg_temp.id('t2'), pg_temp.id('story')]), 2, 'add more work');
reset role;
select is((select array_agg(sprint_id = pg_temp.id('s1') order by issue_number) from public.work_items where id in (pg_temp.id('story'), pg_temp.id('t1'), pg_temp.id('t2'))), array[true, true, true], 'membership persisted');
select is((select sprint_id from public.work_items where id = pg_temp.id('bug')), pg_temp.id('s2'), 'moved bug is in sprint 2');

-- -----------------------------------------------------------------------------
-- Start
-- -----------------------------------------------------------------------------
select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('empty', public.create_sprint(pg_temp.id('p1'), 'Empty', null, '2027-03-01', '2027-03-14'));
insert into t_ids values ('nodates', public.create_sprint(pg_temp.id('p1'), 'No dates'));
select throws_ok($q$select public.start_sprint(pg_temp.id('empty'))$q$, '22023', 'sprint_empty', 'empty sprints cannot start');
select throws_ok($q$select public.start_sprint(pg_temp.id('nodates'))$q$, '22023', 'invalid_sprint_dates', 'dates are required to start');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.start_sprint(pg_temp.id('s1'))$q$, '42501', 'forbidden', 'developers cannot start sprints');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.start_sprint(pg_temp.id('s1'))$q$, 'start sprint 1');
select throws_ok($q$select public.start_sprint(pg_temp.id('s2'))$q$, '23505', 'active_sprint_exists', 'only one active sprint per project');
select throws_ok($q$select public.start_sprint(pg_temp.id('s1'))$q$, '22023', 'invalid_sprint_transition', 'an active sprint cannot start again');
select throws_ok($q$select public.cancel_sprint(pg_temp.id('s1'))$q$, '22023', 'invalid_sprint_transition', 'only planned sprints can be cancelled');
select throws_ok($q$select public.update_sprint(pg_temp.id('s1'), 'Sprint 1', null, '2027-01-05', '2027-01-18')$q$, '55000', 'sprint_started', 'start date is fixed once active');
select lives_ok($q$select public.update_sprint(pg_temp.id('s1'), 'Sprint 1', 'Ship checkout', '2027-01-04', '2027-01-21')$q$, 'end date can still move');
select lives_ok($q$select public.set_sprint_capacity(pg_temp.id('s1'), 20)$q$, 'capacity can change');
reset role;
select is((select array_agg(status::text order by issue_number) from public.work_items where sprint_id = pg_temp.id('s1')), array['BACKLOG','TODO','BACKLOG'], 'starting a sprint changes no item status');
select throws_ok($q$update public.sprints set status = 'ACTIVE', started_at = now() where id = pg_temp.id('empty')$q$, '23505', null, 'unique index blocks a second active sprint for every writer');

-- -----------------------------------------------------------------------------
-- Cancel
-- -----------------------------------------------------------------------------
select pg_temp.login('pm1'); set local role authenticated;
select is(public.cancel_sprint(pg_temp.id('s2')), 1, 'cancel returns the bug to the backlog');
select throws_ok($q$select public.update_sprint(pg_temp.id('s2'), 'Renamed')$q$, '55000', 'sprint_closed', 'cancelled sprints are frozen');
select throws_ok($q$select public.add_work_items_to_sprint(pg_temp.id('s2'), array[pg_temp.id('bug')])$q$, '55000', 'sprint_closed', 'no work added to cancelled sprints');
reset role;
select is((select row(sprint_id, status::text) from public.work_items where id = pg_temp.id('bug')), row(null::uuid, 'BACKLOG'::text), 'bug back in the backlog, status unchanged');
select throws_ok($q$update public.sprints set name = 'X' where id = pg_temp.id('s2')$q$, '55000', 'sprint_closed', 'closed sprints are immutable for every writer');

-- -----------------------------------------------------------------------------
-- Complete with carry-over
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated; -- dev1 is assigned to t2
select public.change_work_item_status(pg_temp.id('t2'), 'TODO');
select public.change_work_item_status(pg_temp.id('t2'), 'IN_PROGRESS');
select public.change_work_item_status(pg_temp.id('t2'), 'IN_REVIEW');
-- Approval is manager-only (8F2).
reset role; select pg_temp.login('pm1'); set local role authenticated;
select public.change_work_item_status(pg_temp.id('t2'), 'DONE');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.complete_sprint(pg_temp.id('s1'))$q$, '42501', 'forbidden', 'developers cannot complete sprints');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select public.complete_sprint(pg_temp.id('s1'))$q$, '22023', 'unfinished_work_requires_decision', 'unfinished work needs an explicit decision');
select throws_ok($q$select public.complete_sprint(pg_temp.id('s1'), 'sprint', pg_temp.id('s2'))$q$, '22023', 'invalid_carry_over_sprint', 'cannot carry into a cancelled sprint');
select throws_ok($q$select public.complete_sprint(pg_temp.id('s1'), 'sprint', null)$q$, '22023', 'invalid_carry_over_sprint', 'a target sprint is required');
select is(public.complete_sprint(pg_temp.id('s1'), 'sprint', pg_temp.id('s3')), 2, 'complete: two unfinished items carried to sprint 3');
reset role;
select is((select row(status::text, completed_at is not null) from public.sprints where id = pg_temp.id('s1')), row('COMPLETED'::text, true), 'sprint completed');
select is((select array_agg(issue_key order by issue_number) from public.work_items where sprint_id = pg_temp.id('s1')), array['SPK-4'], 'done work stays with the completed sprint');
select is((select array_agg(status::text order by issue_number) from public.work_items where sprint_id = pg_temp.id('s3')), array['BACKLOG','TODO'], 'carried items keep their status (nothing marked done)');
select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select public.set_sprint_capacity(pg_temp.id('s1'), 5)$q$, '55000', 'sprint_closed', 'completed sprints are frozen');
select throws_ok($q$select public.remove_work_items_from_sprint(pg_temp.id('s1'), array[pg_temp.id('t2')])$q$, '55000', 'sprint_closed', 'completed history cannot be edited');
select lives_ok($q$select public.start_sprint(pg_temp.id('s3'))$q$, 'next sprint can start once the previous one completed');
select is(public.complete_sprint(pg_temp.id('s3'), 'backlog', null), 2, 'carry unfinished work back to the backlog');
reset role;
select is((select count(*)::int from public.work_items where project_id = pg_temp.id('p1') and sprint_id = pg_temp.id('s3')), 0, 'nothing silently left in the completed sprint');
select is((select count(*)::int from public.work_items where project_id = pg_temp.id('p1')), 8, 'no work item was deleted');

-- -----------------------------------------------------------------------------
-- Reading: members yes, outsiders no; pagination
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select is((select count(*)::int from public.list_sprints(pg_temp.id('p1'))), 5, 'member developer lists sprints');
select is((select name from public.get_sprint(pg_temp.id('s1'))), 'Sprint 1', 'member developer reads a sprint');
select is((select count(*)::int from public.list_sprint_items(pg_temp.id('s1'))), 1, 'member developer reads sprint items');
select is((select count(*)::int from public.sprints where project_id = pg_temp.id('p1')), 5, 'RLS: members read sprint rows');
select is((select array_agg(status::text) from public.list_sprints(pg_temp.id('p1'), 'open')), array['PLANNING','PLANNING'], 'open scope');
select is((select count(*)::int from public.list_sprints(pg_temp.id('p1'), 'closed')), 3, 'closed scope');
select is((select count(*)::int from public.list_sprints(pg_temp.id('p1'), 'all', 2, 4)), 1, 'pagination');
select is((select total_count::int from public.list_sprints(pg_temp.id('p1'), 'all', 1, 1)), 5, 'total count');
select throws_ok($q$select * from public.list_sprints(pg_temp.id('p1'), 'everything')$q$, '22023', 'invalid_scope', 'scope allow-listed');
reset role; select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.list_sprints(pg_temp.id('p1'))$q$, 'P0002', 'project_not_found', 'outsider cannot list');
select is((select count(*)::int from public.get_sprint(pg_temp.id('s1'))), 0, 'outsider cannot read a sprint');
select throws_ok($q$select * from public.list_sprint_items(pg_temp.id('s1'))$q$, 'P0002', 'sprint_not_found', 'outsider cannot read items');
select throws_ok($q$select * from public.sprint_capacity(pg_temp.id('s1'))$q$, 'P0002', 'sprint_not_found', 'outsider cannot read capacity');
select is((select count(*)::int from public.sprints where project_id = pg_temp.id('p1')), 0, 'RLS hides other projects'' sprints');
reset role; select pg_temp.login('sa'); set local role authenticated;
select is((select count(*)::int from public.list_sprints(pg_temp.id('p2'))), 1, 'Super Admin reads any project');
select lives_ok($q$select public.set_sprint_capacity(pg_temp.id('xs'), 12)$q$, 'Super Admin manages any project');

-- -----------------------------------------------------------------------------
-- Audit and activity
-- -----------------------------------------------------------------------------
reset role;
select set_eq($q$select distinct action from private.project_audit_log where project_id = pg_temp.id('p1') and (action like 'SPRINT_%' or action like '%SPRINT%')$q$,
  array['SPRINT_CREATED','SPRINT_UPDATED','SPRINT_CAPACITY_CHANGED','SPRINT_STARTED','SPRINT_COMPLETED','SPRINT_CANCELLED',
        'WORK_ITEM_ADDED_TO_SPRINT','WORK_ITEM_REMOVED_FROM_SPRINT','WORK_ITEM_MOVED_BETWEEN_SPRINTS'], 'every sprint event is recorded');
select ok((select bool_and(sprint_id is not null) from private.project_audit_log where action like 'SPRINT_%'), 'sprint events carry sprint_id');
select is((select new_values from private.project_audit_log where action = 'SPRINT_COMPLETED' and sprint_id = pg_temp.id('s1')),
          pg_catalog.jsonb_build_object('completed_items', 1, 'carried_over', 2, 'carried_to_sprint_id', pg_temp.id('s3')), 'completion records counts and destination');
select is((select count(*)::int from private.project_audit_log where action = 'WORK_ITEM_REMOVED_FROM_SPRINT' and old_values->>'sprint_id' = pg_temp.id('s2')::text), 1, 'cancellation audits each returned item');
select ok((select bool_and(actor_id = pg_temp.uid('pm1')) from private.project_audit_log where project_id = pg_temp.id('p1') and action like 'SPRINT_%'), 'actor recorded');
select pg_temp.login('dev1'); set local role authenticated;
create temporary table t_feed on commit drop as select * from public.list_project_activity(pg_temp.id('p1'), p_limit => 101);
reset role;
select is((select row(sprint_name, previous_subject_name) from t_feed where action = 'SPRINT_COMPLETED' and sprint_id = pg_temp.id('s1')),
          row('Sprint 1'::text, 'Sprint 3'::text), 'activity: completion with carry-over target');
select is((select row(subject_name, previous_subject_name) from t_feed where action = 'WORK_ITEM_MOVED_BETWEEN_SPRINTS' and work_item_key = 'SPK-5'),
          row('Sprint 2'::text, 'Sprint 1'::text), 'activity: move between sprints');
select ok((select changes @> '[{"field":"capacity_points","from":"10.0","to":"20"}]'::jsonb from t_feed where action = 'SPRINT_CAPACITY_CHANGED'), 'capacity change details');
select ok(not exists (select 1 from t_feed where changes::text like '%Ship checkout%' or changes::text like '%Secret%'), 'goal and description text never returned');

select * from finish();
rollback;
