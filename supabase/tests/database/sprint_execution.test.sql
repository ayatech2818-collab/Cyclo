-- Phase 8F2: developer execution, review, blocking, board, progress and burndown.
-- Runs in a rolled-back transaction. Concurrency is covered in tests/integration/sprint-execution.local.mjs.
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
  ('pm1',  '86000000-0000-4000-a000-000000000001'),
  ('pm2',  '86000000-0000-4000-a000-000000000002'),
  ('dev1', '86000000-0000-4000-a000-000000000003'),
  ('dev2', '86000000-0000-4000-a000-000000000004'),
  ('out',  '86000000-0000-4000-a000-000000000005');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8g-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8G ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'PROJECT_MANAGER' where id in ('86000000-0000-4000-a000-000000000001', '86000000-0000-4000-a000-000000000002');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;
create function pg_temp.status(p_key text) returns text language sql as $$ select status::text from public.work_items where id = (select id from t_ids where key = p_key) $$;

-- History rows written in this transaction all share now(); re-date them per step (as the table owner).
create temporary table t_seen (id bigint primary key) on commit drop;
create function pg_temp.at_day(p_offset integer) returns void language sql as $$
  update private.sprint_item_history set recorded_at = ((current_date + p_offset)::timestamp + interval '10 hours') at time zone 'UTC'
   where id not in (select id from t_seen);
  insert into t_seen select id from private.sprint_item_history on conflict do nothing;
$$;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8G One', 'EXA', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
insert into t_ids values ('a', public.create_work_item(pg_temp.id('p1'), 'TASK', 'A', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1'), p_estimate => 5));
insert into t_ids values ('b', public.create_work_item(pg_temp.id('p1'), 'TASK', 'B', p_status => 'TODO', p_assignee_id => pg_temp.uid('dev2'), p_estimate => 3));
insert into t_ids values ('c', public.create_work_item(pg_temp.id('p1'), 'BUG', 'C', p_status => 'TODO', p_estimate => 2));
insert into t_ids values ('d', public.create_work_item(pg_temp.id('p1'), 'TASK', 'D (unestimated)', p_status => 'TODO'));
insert into t_ids values ('e', public.create_work_item(pg_temp.id('p1'), 'STORY', 'E (added later)', p_status => 'TODO', p_estimate => 6));
insert into t_ids values ('x', public.create_work_item(pg_temp.id('p1'), 'TASK', 'X (cancelled)', p_status => 'TODO', p_estimate => 1));
insert into t_ids values ('s', public.create_sprint(pg_temp.id('p1'), 'Exec sprint', null, current_date - 5, current_date + 5, 20));
insert into t_ids values ('plan', public.create_sprint(pg_temp.id('p1'), 'Later', null, current_date + 6, current_date + 20));
select public.add_work_items_to_sprint(pg_temp.id('s'), array[pg_temp.id('a'), pg_temp.id('b'), pg_temp.id('c'), pg_temp.id('d'), pg_temp.id('x')]);
reset role;
select pg_temp.at_day(-10); -- nothing recorded yet (sprint not active)
select is((select count(*)::int from private.sprint_item_history where sprint_id = pg_temp.id('s')), 0, 'no history while planning');

-- Day -4: start (baseline). Then cancel X the same day.
select pg_temp.login('pm1'); set local role authenticated;
select public.start_sprint(pg_temp.id('s'));
select public.change_work_item_status(pg_temp.id('x'), 'CANCELLED');
reset role; select pg_temp.at_day(-4);
select is((select count(*)::int from private.sprint_item_history where sprint_id = pg_temp.id('s') and kind = 'baseline'), 5, 'baseline row per item at start');

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.sprint_item_history', 'select'), 'history is private');
select ok(not has_table_privilege('cyclo_project_api', 'private.sprint_item_history', 'insert'), 'history is written by triggers only');
select ok(not has_column_privilege('authenticated', 'public.work_items', 'blocked_reason', 'update'), 'no direct reason writes');
select ok(not has_function_privilege('anon', 'public.execute_work_item(uuid,text,public.work_item_status,text)', 'execute'), 'anon cannot execute work');
select is((select manager_only from private.work_item_transitions where from_status = 'IN_REVIEW' and to_status = 'DONE'), true, 'approval is manager-only');
select is((select manager_only from private.work_item_transitions where from_status = 'IN_REVIEW' and to_status = 'IN_PROGRESS'), true, 'rejection is manager-only');

-- -----------------------------------------------------------------------------
-- Day -3: developer executes A to review; PM approves.
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select is((select row(status::text, changed) from public.execute_work_item(pg_temp.id('a'), 'start', 'TODO')), row('IN_PROGRESS'::text, true), 'Start Work: TODO -> IN_PROGRESS');
select is((select changed from public.execute_work_item(pg_temp.id('a'), 'start', 'TODO')), false, 'retrying the same request is a no-op');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'TODO')$q$, '55000', 'status_changed', 'stale expected status is refused');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'start', 'IN_PROGRESS')$q$, '22023', 'invalid_transition', 'cannot start work already in progress');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'finish', 'IN_PROGRESS')$q$, '22023', 'invalid_action', 'actions are allow-listed');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'block', 'IN_PROGRESS')$q$, '22023', 'reason_required', 'blocking requires a reason');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'block', 'IN_PROGRESS', ' x ')$q$, '22023', 'reason_required', 'reason must be meaningful (3+ chars)');
select is((select row(status::text, blocked_from_status::text, blocked_reason) from public.execute_work_item(pg_temp.id('a'), 'block', 'IN_PROGRESS', '  Waiting for API keys ')),
          row('BLOCKED'::text, 'IN_PROGRESS'::text, 'Waiting for API keys'::text), 'Mark Blocked records the reason and origin');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('a'), 'TODO')$q$, '22023', 'invalid_transition', 'blocked work returns only to its origin');
select is((select row(status::text, blocked_reason) from public.execute_work_item(pg_temp.id('a'), 'resume', 'BLOCKED')), row('IN_PROGRESS'::text, null::text), 'resume returns to the recorded status and clears the reason');
select is((select status::text from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'IN_PROGRESS')), 'IN_REVIEW', 'Submit for Review');
select is(pg_temp.status('a'), 'IN_REVIEW', 'submitting never marks work done');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')$q$, '42501', 'forbidden', 'developers cannot approve');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'reject', 'IN_REVIEW', 'nope')$q$, '42501', 'forbidden', 'developers cannot reject');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('a'), 'DONE')$q$, '42501', 'forbidden', 'no generic self-approval either');
select throws_ok($q$select public.change_work_item_priority(pg_temp.id('a'), 'high')$q$, '42501', 'forbidden', 'developers cannot change priority');
select throws_ok($q$select public.assign_work_item(pg_temp.id('a'), pg_temp.uid('dev2'))$q$, '42501', 'forbidden', 'developers cannot reassign');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'start', 'TODO')$q$, '42501', 'forbidden', 'cannot execute another developer''s task');
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('c'), 'start', 'TODO')$q$, '42501', 'forbidden', 'cannot execute unassigned work');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'reject', 'IN_REVIEW')$q$, '22023', 'reason_required', 'rejection requires a reason');
select is((select status::text from public.execute_work_item(pg_temp.id('a'), 'reject', 'IN_REVIEW', 'Add tests for the error path')), 'IN_PROGRESS', 'PM rejects: back to IN_PROGRESS');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select lives_ok($q$select * from public.execute_work_item(pg_temp.id('a'), 'submit_review', 'IN_PROGRESS')$q$, 'resubmit');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select is((select status::text from public.execute_work_item(pg_temp.id('a'), 'approve', 'IN_REVIEW')), 'DONE', 'PM approves: DONE');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('b'), 'BLOCKED')$q$, '22023', 'blocked_reason_required', 'generic status change cannot block without a reason');
reset role; select pg_temp.at_day(-3);
select throws_ok($q$update public.work_items set status = 'BLOCKED', blocked_from_status = 'TODO' where id = pg_temp.id('b')$q$, '23514', null, 'a reason is required for every writer');

select pg_temp.login('out'); set local role authenticated;
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'start', 'TODO')$q$, 'P0002', 'work_item_not_found', 'non-member developer cannot see or execute the item');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select * from public.execute_work_item(pg_temp.id('b'), 'start', 'TODO')$q$, 'P0002', 'work_item_not_found', 'unrelated PM is denied');
select throws_ok($q$select * from public.list_sprint_board(pg_temp.id('s'))$q$, 'P0002', 'sprint_not_found', 'unrelated PM cannot see the board');
reset role;

-- Day -2: C re-estimated 2 -> 4 after the sprint started; E added.
select pg_temp.login('pm1'); set local role authenticated;
select public.update_work_item(pg_temp.id('c'), 'C', null, null, null, 4);
select public.add_work_items_to_sprint(pg_temp.id('s'), array[pg_temp.id('e')]);
reset role; select pg_temp.at_day(-2);

-- Day -1: B removed from the sprint; D blocked by its manager.
select pg_temp.login('pm1'); set local role authenticated;
select public.remove_work_items_from_sprint(pg_temp.id('s'), array[pg_temp.id('b')]);
select * from public.execute_work_item(pg_temp.id('d'), 'block', 'TODO', 'Needs design sign-off');
reset role; select pg_temp.at_day(-1);

-- -----------------------------------------------------------------------------
-- Board, progress, execution context (developer view)
-- -----------------------------------------------------------------------------
-- Review decisions in this transaction share now(); order them as they happened.
update private.project_audit_log set created_at = created_at - interval '1 minute'
 where work_item_id = pg_temp.id('a') and action = 'WORK_ITEM_REVIEW_REJECTED';
select pg_temp.login('dev2'); set local role authenticated;
select set_eq($q$select issue_key from public.list_sprint_board(pg_temp.id('s'))$q$, array['EXA-1','EXA-3','EXA-4','EXA-5'], 'board: active work only (no cancelled, no removed)');
select is((select blocked_reason from public.list_sprint_board(pg_temp.id('s')) where issue_key = 'EXA-4'), 'Needs design sign-off', 'board shows the blocking reason');
create temporary table t_progress on commit drop as select * from public.sprint_progress(pg_temp.id('s'));
create temporary table t_exec on commit drop as select * from public.work_item_execution(pg_temp.id('a'));
create temporary table t_burn on commit drop as select * from public.sprint_burndown(pg_temp.id('s'));
create temporary table t_feed on commit drop as select * from public.list_project_activity(pg_temp.id('p1'), p_limit => 101);
reset role;
select is((select row(total_items, completed_items, remaining_items, cancelled_items) from t_progress where scope = 'total'), row(4, 1, 3, 1),
          'progress items: cancelled work is excluded and not completed');
select is((select row(total_points, completed_points, remaining_points, unestimated_items, completion_percent) from t_progress where scope = 'total'),
          row(15::numeric, 5::numeric, 10::numeric, 1, 33), 'progress points and completion % (5 of 15)');
select is((select row(total_items, completed_items, completed_points) from t_progress where scope = 'assignee' and assignee_id = pg_temp.uid('dev1')),
          row(1, 1, 5::numeric), 'per-developer assigned and completed work');
select is((select row(sprint_name, sprint_status::text, last_review_action, last_review_by) from t_exec),
          row('Exec sprint'::text, 'ACTIVE'::text, 'WORK_ITEM_REVIEW_APPROVED'::text, 'P8G pm1'::text), 'execution context: sprint and latest review');

-- -----------------------------------------------------------------------------
-- Burndown replay
-- -----------------------------------------------------------------------------
select is((select count(*)::int from t_burn), 6, 'one row per day from start date to today (never the future)');
select is((select row(has_data, remaining_points) from t_burn where day = current_date - 5), row(false, null::numeric), 'before the baseline: missing data, not zero');
select is((select row(scope_points, remaining_points, completed_points, remaining_items) from t_burn where day = current_date - 4),
          row(10::numeric, 10::numeric, 0::numeric, 4), 'start day: A5 + B3 + C2, X cancelled, D unestimated');
select is((select row(scope_points, remaining_points, completed_points) from t_burn where day = current_date - 3),
          row(10::numeric, 5::numeric, 5::numeric), 'A done');
select is((select row(scope_points, remaining_points) from t_burn where day = current_date - 2),
          row(18::numeric, 13::numeric), 'C re-estimated to 4 and E (6) added: scope grows');
select is((select row(scope_points, remaining_points) from t_burn where day = current_date - 1),
          row(15::numeric, 10::numeric), 'B removed');
select is((select remaining_points from t_burn where day = current_date - 4), 10::numeric, 'later estimate changes do not rewrite earlier days');
select is((select row(has_data, remaining_points) from t_burn where day = current_date), row(true, 10::numeric), 'today carries the latest state');
select is((select row(b.remaining_points, p.total_points - p.completed_points) from t_burn as b, t_progress as p where b.day = current_date and p.scope = 'total'),
          row(10::numeric, 10::numeric), 'burndown and progress agree on remaining points');

-- -----------------------------------------------------------------------------
-- Audit and activity
-- -----------------------------------------------------------------------------
select set_eq($q$select distinct action from private.project_audit_log where work_item_id = pg_temp.id('a')$q$,
  array['WORK_ITEM_CREATED','WORK_ITEM_ADDED_TO_SPRINT','WORK_ITEM_STARTED','WORK_ITEM_BLOCKED','WORK_ITEM_RESUMED',
        'WORK_ITEM_SUBMITTED_FOR_REVIEW','WORK_ITEM_REVIEW_REJECTED','WORK_ITEM_REVIEW_APPROVED'], 'every execution step is audited');
select is((select count(*)::int from private.project_audit_log where work_item_id = pg_temp.id('a') and action = 'WORK_ITEM_STARTED'), 1, 'retried request recorded once');
select is((select actor_id from private.project_audit_log where work_item_id = pg_temp.id('a') and action = 'WORK_ITEM_REVIEW_APPROVED'), pg_temp.uid('pm1'), 'approval actor');
select ok((select changes @> '[{"field":"reason","to":"Waiting for API keys"}]'::jsonb from t_feed where action = 'WORK_ITEM_BLOCKED' and work_item_key = 'EXA-1'), 'activity shows the blocking reason');
select ok((select changes @> '[{"field":"reason","to":"Add tests for the error path"}]'::jsonb from t_feed where action = 'WORK_ITEM_REVIEW_REJECTED'), 'activity shows the review feedback');

-- Completing the sprint stops recording; history stays.
select pg_temp.login('pm1'); set local role authenticated;
select public.complete_sprint(pg_temp.id('s'), 'sprint', pg_temp.id('plan'));
reset role;
select ok((select count(*) from private.sprint_item_history where sprint_id = pg_temp.id('s') and not in_sprint and kind = 'change') >= 2, 'carry-over recorded as leaving the sprint');
select is((select count(*)::int from private.sprint_item_history where sprint_id = pg_temp.id('plan')), 0, 'planned sprints record nothing until they start');

select * from finish();
rollback;
