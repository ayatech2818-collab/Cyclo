-- Phase 8E: backlog (ordering, rebalance, filters, grouping, summary, bulk, permissions, audit).
-- Runs inside a transaction that is rolled back; no data is left behind.
-- Concurrency is exercised over HTTP in tests/integration/backlog.local.mjs.
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
  ('sa',   '84000000-0000-4000-a000-000000000001'),
  ('pm1',  '84000000-0000-4000-a000-000000000002'),
  ('pm2',  '84000000-0000-4000-a000-000000000003'),
  ('dev1', '84000000-0000-4000-a000-000000000004'),
  ('dev2', '84000000-0000-4000-a000-000000000005');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', 'p8e-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8E ' || (select key from t_users t where t.id = profiles.id) where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN' where id = '84000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('84000000-0000-4000-a000-000000000002', '84000000-0000-4000-a000-000000000003');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims', pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;
create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;
-- Backlog keys in rank order for the given filters (as the current user).
create function pg_temp.order_of(p_project uuid) returns text[] language sql as $$
  select array_agg(issue_key order by backlog_rank) from public.list_backlog(p_project, p_page_size => 100)
$$;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8E One', 'BLA', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
insert into t_ids values ('e1', public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Checkout'));                                                -- BLA-1
insert into t_ids values ('e2', public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Search'));                                                  -- BLA-2
insert into t_ids values ('s1', public.create_work_item(pg_temp.id('p1'), 'STORY', 'Pay by card', p_parent_id => pg_temp.id('e1'), p_estimate => 5));   -- BLA-3
insert into t_ids values ('t1', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Card form', p_parent_id => pg_temp.id('s1'), p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1'), p_estimate => 3)); -- BLA-4
insert into t_ids values ('st', public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Validate CVV', p_parent_id => pg_temp.id('t1')));        -- BLA-5
insert into t_ids values ('b1', public.create_work_item(pg_temp.id('p1'), 'BUG', 'Crash on submit', p_priority => 'critical'));               -- BLA-6
insert into t_ids values ('t2', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Standalone task', p_priority => 'low'));                  -- BLA-7
insert into t_ids values ('b2', public.create_work_item(pg_temp.id('p1'), 'BUG', 'Search typo', p_parent_id => pg_temp.id('e2')));           -- BLA-8
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8E Two', 'BLB', 'medium'));
insert into t_ids values ('x1', public.create_work_item(pg_temp.id('p2'), 'TASK', 'Elsewhere'));
reset role;

-- -----------------------------------------------------------------------------
-- Structure and new-item ranks
-- -----------------------------------------------------------------------------
select col_not_null('public', 'work_items', 'backlog_rank', 'every item has a rank');
select col_is_unique('public', 'work_items', array['project_id', 'backlog_rank'], 'ranks are unique per project');
select ok(not has_column_privilege('authenticated', 'public.work_items', 'backlog_rank', 'update'), 'employees cannot write ranks directly');
select ok(not has_function_privilege('authenticated', 'private.rebalance_backlog(uuid)', 'execute'), 'rebalance is internal');
select is((select array_agg(backlog_rank order by issue_number) from public.work_items where project_id = pg_temp.id('p1')),
          array[1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192]::numeric[], 'new items are appended in creation order');
select is((select backlog_rank from public.work_items where id = pg_temp.id('x1')), 1024::numeric, 'ranks are per project');

-- -----------------------------------------------------------------------------
-- Listing: scope, epic resolution, subtasks
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('dev1'); set local role authenticated;
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-3','BLA-4','BLA-6','BLA-7','BLA-8'], 'backlog lists stories, tasks and bugs in rank order (no epics/subtasks)');
select is((select epic_key from public.list_backlog(pg_temp.id('p1')) where issue_key = 'BLA-4'), 'BLA-1', 'task inherits the epic of its story');
select is((select epic_key from public.list_backlog(pg_temp.id('p1')) where issue_key = 'BLA-8'), 'BLA-2', 'bug linked to an epic');
select is((select epic_key from public.list_backlog(pg_temp.id('p1')) where issue_key = 'BLA-6'), null, 'standalone bug has no epic');
select is((select subtask_count from public.list_backlog(pg_temp.id('p1')) where issue_key = 'BLA-4'), 1, 'subtasks are counted on their task');
select throws_ok($q$select * from public.list_backlog(pg_temp.id('p2'))$q$, 'P0002', 'project_not_found', 'developer cannot read another project backlog');
reset role; select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.list_backlog(pg_temp.id('p1'))$q$, 'P0002', 'project_not_found', 'non-member cannot read the backlog');
select throws_ok($q$select * from public.backlog_summary(pg_temp.id('p1'))$q$, 'P0002', 'project_not_found', 'non-member cannot read the summary');

-- -----------------------------------------------------------------------------
-- Moving
-- -----------------------------------------------------------------------------
reset role;
create temporary table t_before on commit drop as select id, status, priority, assignee_id, parent_id, updated_at from public.work_items where project_id = (select id from t_ids where key = 'p1');
select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.move_backlog_item(pg_temp.id('b2'), p_after_id => pg_temp.id('s1'))$q$, 'move BLA-8 right after BLA-3');
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-3','BLA-8','BLA-4','BLA-6','BLA-7'], 'new order persisted');
select lives_ok($q$select public.move_backlog_item(pg_temp.id('t2'), p_before_id => pg_temp.id('s1'))$q$, 'move BLA-7 to the top');
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-7','BLA-3','BLA-8','BLA-4','BLA-6'], 'top placement');
select lives_ok($q$select public.move_backlog_item(pg_temp.id('t2'), p_after_id => pg_temp.id('b1'))$q$, 'move BLA-7 to the bottom');
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-3','BLA-8','BLA-4','BLA-6','BLA-7'], 'bottom placement');
select lives_ok($q$select public.move_backlog_item(pg_temp.id('t2'), p_after_id => pg_temp.id('b1'))$q$, 'moving to the current place is a no-op');
-- Stale view: "after BLA-3, before BLA-6" although BLA-8 and BLA-4 are in between -> placed right after BLA-3.
select lives_ok($q$select public.move_backlog_item(pg_temp.id('b1'), pg_temp.id('s1'), pg_temp.id('t1'))$q$, 'stale neighbours are tolerated');
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-3','BLA-6','BLA-8','BLA-4','BLA-7'], 'placed right after the requested predecessor');
reset role;
select ok(not exists (
  select 1 from public.work_items w join t_before b using (id)
   where w.status <> b.status or w.priority <> b.priority or w.assignee_id is distinct from b.assignee_id
      or w.parent_id is distinct from b.parent_id or w.updated_at <> b.updated_at), 'reordering changes nothing else (status, hierarchy, updated_at)');

select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select public.move_backlog_item(pg_temp.id('b1'))$q$, '22023', 'invalid_position', 'a neighbour is required');
select throws_ok($q$select public.move_backlog_item(pg_temp.id('b1'), pg_temp.id('b1'))$q$, '22023', 'invalid_position', 'cannot place next to itself');
select throws_ok($q$select public.move_backlog_item(pg_temp.id('b1'), pg_temp.id('x1'))$q$, '22023', 'invalid_position', 'neighbour from another project rejected');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.move_backlog_item(pg_temp.id('t1'), pg_temp.id('s1'))$q$, '42501', 'forbidden', 'developers cannot reorder (even their own item)');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select public.move_backlog_item(pg_temp.id('t1'), pg_temp.id('s1'))$q$, 'P0002', 'work_item_not_found', 'other PM cannot reorder');
reset role; select pg_temp.login('sa'); set local role authenticated;
select lives_ok($q$select public.move_backlog_item(pg_temp.id('t2'), p_before_id => pg_temp.id('s1'))$q$, 'Super Admin reorders any project');
select lives_ok($q$select public.move_backlog_item(pg_temp.id('t2'), p_after_id => pg_temp.id('t1'))$q$, 'and back to the bottom');

-- Repeated bisection of one gap triggers a rebalance; order and uniqueness survive.
reset role; select pg_temp.login('pm1'); set local role authenticated;
do $$
begin
  for i in 1..30 loop
    perform public.move_backlog_item((select id from t_ids where key = case when i % 2 = 0 then 'b1' else 'b2' end),
                                     p_after_id => (select id from t_ids where key = 's1'));
  end loop;
end;
$$;
reset role;
select is((select max(scale(backlog_rank)) <= 10 from public.work_items where project_id = pg_temp.id('p1')), true, 'precision stays bounded (rebalanced)');
select is((select count(distinct backlog_rank) = count(*) from public.work_items where project_id = pg_temp.id('p1')), true, 'ranks remain unique');
select pg_temp.login('pm1'); set local role authenticated;
select is(pg_temp.order_of(pg_temp.id('p1')), array['BLA-3','BLA-6','BLA-8','BLA-4','BLA-7'], 'order intact after 30 bisections (last moved item directly after BLA-3)');
select lives_ok($q$insert into t_ids values ('t3', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Late task'))$q$, 'create after many moves');
select is((pg_temp.order_of(pg_temp.id('p1')))[6], 'BLA-9', 'new items still go to the bottom');

-- -----------------------------------------------------------------------------
-- Filters, search, grouping, pagination
-- -----------------------------------------------------------------------------
select is((select array_agg(issue_key order by backlog_rank) from public.list_backlog(pg_temp.id('p1'), p_type => 'BUG')), array['BLA-6','BLA-8'], 'type filter');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_status => 'TODO')), array['BLA-4'], 'status filter');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_priority => 'critical')), array['BLA-6'], 'priority filter');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_assignee_id => pg_temp.uid('dev1'))), array['BLA-4'], 'assignee filter');
select is((select count(*)::int from public.list_backlog(pg_temp.id('p1'), p_unassigned => true)), 5, 'unassigned filter');
select is((select array_agg(issue_key order by backlog_rank) from public.list_backlog(pg_temp.id('p1'), p_epic_id => pg_temp.id('e1'))), array['BLA-3','BLA-4'], 'epic filter');
select is((select array_agg(issue_key order by backlog_rank) from public.list_backlog(pg_temp.id('p1'), p_no_epic => true)), array['BLA-6','BLA-7','BLA-9'], 'no-epic filter');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_search => 'bla-4')), array['BLA-4'], 'search by key');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_search => 'typo')), array['BLA-8'], 'search by title');
select throws_ok($q$select * from public.list_backlog(pg_temp.id('p1'), p_type => 'EPIC')$q$, '22023', 'invalid_type', 'epics are not backlog rows');
select throws_ok($q$select * from public.list_backlog(pg_temp.id('p1'), p_group => 'x; drop')$q$, '22023', 'invalid_group', 'grouping is allow-listed');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_group => 'priority', p_page_size => 100)),
          array['BLA-6','BLA-3','BLA-8','BLA-4','BLA-9','BLA-7'], 'priority grouping: critical first, rank within group');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_group => 'epic', p_page_size => 100)),
          array['BLA-3','BLA-4','BLA-8','BLA-6','BLA-7','BLA-9'], 'epic grouping: epics in rank order, no-epic last');
select is((select array_agg(issue_key) from public.list_backlog(pg_temp.id('p1'), p_page => 2, p_page_size => 4)), array['BLA-7','BLA-9'], 'pagination');
select is((select total_count::int from public.list_backlog(pg_temp.id('p1'), p_page_size => 1) limit 1), 6, 'total count');

-- Completed work leaves the default backlog view.
reset role; select pg_temp.login('dev1'); set local role authenticated;
select public.change_work_item_status(pg_temp.id('t1'), 'IN_PROGRESS');
select public.change_work_item_status(pg_temp.id('t1'), 'IN_REVIEW');
-- Approval is manager-only (8F2).
reset role; select pg_temp.login('pm1'); set local role authenticated;
select public.change_work_item_status(pg_temp.id('t1'), 'DONE');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select ok(not exists (select 1 from public.list_backlog(pg_temp.id('p1')) where issue_key = 'BLA-4'), 'done items are hidden by default');
select ok(exists (select 1 from public.list_backlog(pg_temp.id('p1'), p_include_completed => true) where issue_key = 'BLA-4'), 'and shown on request');

-- -----------------------------------------------------------------------------
-- Summary
-- -----------------------------------------------------------------------------
create temporary table t_summary on commit drop as select * from public.backlog_summary(pg_temp.id('p1'));
reset role;
select is((select row(item_count, estimate_total) from t_summary where dimension = 'total'), row(5, 5::numeric), 'total open items and estimate');
select is((select item_count from t_summary where dimension = 'status' and key = 'BACKLOG'), 5, 'status counts');
select is((select item_count from t_summary where dimension = 'assignee' and key = 'unassigned'), 5, 'unassigned count');
select is((select item_count from t_summary where dimension = 'estimate' and key = 'unestimated'), 4, 'unestimated count');
select is((select item_count from t_summary where dimension = 'epic' and key = pg_temp.id('e1')::text), 1, 'per-epic counts');
select is((select label from t_summary where dimension = 'epic' and key = pg_temp.id('e2')::text), 'BLA-2 · Search', 'epic labels');
select is((select item_count from t_summary where dimension = 'epic' and key = 'none'), 3, 'items without an epic');

-- -----------------------------------------------------------------------------
-- Bulk planning
-- -----------------------------------------------------------------------------
select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1')], p_change_priority => true, p_priority => 'low')$q$, '42501', 'forbidden', 'developers cannot bulk update');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1')], p_change_priority => true, p_priority => 'low')$q$, 'P0002', 'project_not_found', 'other PM cannot bulk update');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select is(public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1'), pg_temp.id('b2'), pg_temp.id('t2')], p_change_priority => true, p_priority => 'high'), 3, 'bulk priority');
select is(public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1'), pg_temp.id('b2')], p_change_assignee => true, p_assignee_id => pg_temp.uid('dev1')), 2, 'bulk assignee');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1'), pg_temp.id('t2')], p_change_assignee => true, p_assignee_id => pg_temp.uid('dev2'))$q$, '22023', 'invalid_assignee', 'non-member assignee rejected');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1'), pg_temp.id('x1')], p_change_priority => true, p_priority => 'low')$q$, '22023', 'invalid_selection', 'items from another project rejected');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1'), pg_temp.id('b1')], p_change_priority => true, p_priority => 'low')$q$, '22023', 'invalid_selection', 'duplicates rejected');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[]::uuid[], p_change_priority => true, p_priority => 'low')$q$, '22023', 'invalid_selection', 'empty selection rejected');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), (select array_agg(gen_random_uuid()) from generate_series(1, 101)), p_change_priority => true, p_priority => 'low')$q$, '22023', 'invalid_selection', 'at most 100 items');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('b1')])$q$, '22023', 'invalid_bulk_change', 'something must change');
select lives_ok($q$select public.archive_work_item(pg_temp.id('t3'))$q$, 'archive one item');
select throws_ok($q$select public.bulk_update_work_items(pg_temp.id('p1'), array[pg_temp.id('t3')], p_change_priority => true, p_priority => 'low')$q$, '22023', 'invalid_selection', 'archived items rejected');
reset role;
select is((select array_agg(priority::text order by issue_key) from public.work_items where id in (pg_temp.id('b1'), pg_temp.id('t2'))), array['high','high'], 'failed bulk changes are all-or-nothing');
select is((select row(b1.assignee_id, t2.assignee_id) from public.work_items b1, public.work_items t2 where b1.id = pg_temp.id('b1') and t2.id = pg_temp.id('t2')),
          row(pg_temp.uid('dev1'), null::uuid), 'non-member was not assigned to anything');

-- -----------------------------------------------------------------------------
-- Audit and activity
-- -----------------------------------------------------------------------------
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action = 'WORK_ITEM_PRIORITY_CHANGED'), 3, 'bulk priority audited per item');
select is((select count(*)::int from private.project_audit_log where project_id = pg_temp.id('p1') and action = 'WORK_ITEM_ASSIGNED'), 2, 'bulk assignee audited per item');
select ok((select count(*) from private.project_audit_log where action = 'WORK_ITEM_REORDERED' and project_id = pg_temp.id('p1')) >= 34, 'each real move is audited');
select ok(exists (select 1 from private.project_audit_log where action = 'WORK_ITEM_REORDERED' and work_item_id = pg_temp.id('b2')
                  and new_values = '{"after_key":"BLA-3","before_key":"BLA-4"}'::jsonb), 'reorder records neighbour keys');
select ok(not exists (select 1 from private.project_audit_log where action = 'WORK_ITEM_REORDERED' and project_id = pg_temp.id('p1')
                       and (new_values->>'after_key' in ('BLA-1','BLA-2','BLA-5') or new_values->>'before_key' in ('BLA-1','BLA-2','BLA-5'))),
          'neighbour keys only name items shown in the backlog (no epics or subtasks)');
select pg_temp.login('dev1'); set local role authenticated;
select ok(exists (select 1 from public.list_project_activity(pg_temp.id('p1'), p_limit => 101, p_work_item_id => pg_temp.id('t2'))
                  where action = 'WORK_ITEM_REORDERED' and subject_name = 'BLA-3' and previous_subject_name is null),
          'activity: moved to the top (before BLA-3)');

reset role;
select * from finish();
rollback;
