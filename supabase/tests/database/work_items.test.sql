-- Phase 8D: work items (hierarchy, identifiers, workflow, permissions, audit).
-- Runs inside a transaction that is rolled back; no data is left behind.
-- Run: npx supabase test db   (local stack only)
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
  ('sa',      '83000000-0000-4000-a000-000000000001'),
  ('pm1',     '83000000-0000-4000-a000-000000000002'),
  ('pm2',     '83000000-0000-4000-a000-000000000003'),
  ('dev1',    '83000000-0000-4000-a000-000000000004'),
  ('dev2',    '83000000-0000-4000-a000-000000000005'),
  ('dev3',    '83000000-0000-4000-a000-000000000006'),
  ('dev_off', '83000000-0000-4000-a000-000000000007');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'p8d-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;
update public.profiles set is_active = true, full_name = 'P8D ' || (select key from t_users t where t.id = profiles.id)
 where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN'     where id = '83000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('83000000-0000-4000-a000-000000000002', '83000000-0000-4000-a000-000000000003');

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;

create temporary table t_ids (key text primary key, id uuid) on commit drop;
grant select, insert on t_ids to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql as $$ select id from t_ids where key = p_key $$;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('p1', public.create_project('P8D One', 'WIA', 'medium'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev1'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev2'));
select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev_off'));
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('p2', public.create_project('P8D Two', 'WIB', 'medium'));
select public.add_project_member(pg_temp.id('p2'), pg_temp.uid('dev3'));
reset role;
update public.profiles set is_active = false where id = pg_temp.uid('dev_off');

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select has_table('public', 'work_items', 'work_items table exists');
select col_is_unique('public', 'work_items', array['project_id', 'issue_number'], 'issue numbers unique per project');
select col_is_unique('public', 'work_items', 'issue_key', 'issue keys unique');
select ok(not has_table_privilege('authenticated', 'public.work_items', 'insert'), 'no direct INSERT for employees');
select ok(not has_table_privilege('authenticated', 'public.work_items', 'update'), 'no direct UPDATE for employees');
select ok(not has_table_privilege('authenticated', 'public.work_items', 'delete'), 'no direct DELETE for employees');
select ok(not has_table_privilege('service_role', 'public.work_items', 'insert'), 'no INSERT for service_role');
select ok(not has_column_privilege('cyclo_project_api', 'public.work_items', 'issue_key', 'update'), 'RPC owner cannot change issue keys');
select ok(not has_column_privilege('cyclo_project_api', 'public.work_items', 'reporter_id', 'update'), 'RPC owner cannot change reporters');
select ok(not has_column_privilege('cyclo_project_api', 'public.work_items', 'project_id', 'update'), 'RPC owner cannot move items between projects');
select ok(not has_table_privilege('authenticated', 'private.work_item_counters', 'select'), 'counters are private');
select ok(not has_function_privilege('anon', 'public.create_work_item(uuid,public.work_item_type,text,text,uuid,public.work_item_status,public.project_priority,uuid,date,date,numeric)', 'execute'), 'anon cannot create work items');

-- -----------------------------------------------------------------------------
-- Every type, valid hierarchy, sequential keys
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_ids values ('epic',    public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Checkout revamp'));
insert into t_ids values ('story',   public.create_work_item(pg_temp.id('p1'), 'STORY', 'Pay with card', p_parent_id => pg_temp.id('epic')));
insert into t_ids values ('task',    public.create_work_item(pg_temp.id('p1'), 'TASK', 'Card form', p_parent_id => pg_temp.id('story'), p_status => 'TODO', p_assignee_id => pg_temp.uid('dev1')));
insert into t_ids values ('subtask', public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Validate CVV', p_parent_id => pg_temp.id('task')));
insert into t_ids values ('bug',     public.create_work_item(pg_temp.id('p1'), 'BUG', 'Form crashes', p_parent_id => pg_temp.id('task'), p_priority => 'critical'));
insert into t_ids values ('bug2',    public.create_work_item(pg_temp.id('p1'), 'BUG', '  Standalone bug  ', p_description => 'Secret repro steps'));
insert into t_ids values ('task2',   public.create_work_item(pg_temp.id('p1'), 'TASK', 'Standalone task', p_estimate => 3.5, p_start_date => '2027-01-01', p_due_date => '2027-01-10'));
reset role;

select is((select array_agg(issue_key order by issue_number) from public.work_items where project_id = pg_temp.id('p1')),
          array['WIA-1','WIA-2','WIA-3','WIA-4','WIA-5','WIA-6','WIA-7'], 'keys are sequential and project-based');
select is((select array_agg(type::text order by issue_number) from public.work_items where project_id = pg_temp.id('p1')),
          array['EPIC','STORY','TASK','SUBTASK','BUG','BUG','TASK'], 'every work item type can be created');
select is((select row(title, reporter_id) from public.work_items where id = pg_temp.id('bug2')),
          row('Standalone bug'::text, pg_temp.uid('pm1')), 'title trimmed; reporter is the caller');
select is((select last_number from private.work_item_counters where project_id = pg_temp.id('p1')), 7, 'counter tracks the last number');

reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_ids values ('other', public.create_work_item(pg_temp.id('p2'), 'STORY', 'Other project story'));
reset role;
select is((select issue_key from public.work_items where id = pg_temp.id('other')), 'WIB-1', 'numbering is per project');

-- -----------------------------------------------------------------------------
-- Invalid hierarchy
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'EPIC', 'Nested', p_parent_id => pg_temp.id('epic'))$q$, '22023', 'invalid_parent', 'epic cannot have a parent');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'STORY', 'Bad', p_parent_id => pg_temp.id('task'))$q$, '22023', 'invalid_parent', 'story cannot be under a task');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'Bad', p_parent_id => pg_temp.id('epic'))$q$, '22023', 'invalid_parent', 'task cannot be directly under an epic');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Orphan')$q$, '22023', 'invalid_parent', 'subtask requires a parent');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Bad', p_parent_id => pg_temp.id('story'))$q$, '22023', 'invalid_parent', 'subtask must be under a task');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'BUG', 'Bad', p_parent_id => pg_temp.id('subtask'))$q$, '22023', 'invalid_parent', 'bug cannot be under a subtask');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'Bad', p_parent_id => pg_temp.id('bug'))$q$, '22023', 'invalid_parent', 'bugs cannot have children');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'Cross', p_parent_id => pg_temp.id('other'))$q$, '22023', 'invalid_parent', 'parent from another project rejected');
select throws_ok($q$select public.set_work_item_hierarchy(pg_temp.id('story'), 'STORY', pg_temp.id('story'))$q$, '22023', 'invalid_parent', 'self-parenting rejected');
select throws_ok($q$select public.set_work_item_hierarchy(pg_temp.id('task'), 'BUG', pg_temp.id('story'))$q$, '22023', 'invalid_type', 'type change that would orphan children rejected');
select lives_ok($q$select public.set_work_item_hierarchy(pg_temp.id('task2'), 'TASK', pg_temp.id('story'))$q$, 'move a task under a story');
select lives_ok($q$select public.set_work_item_hierarchy(pg_temp.id('bug2'), 'BUG', pg_temp.id('epic'))$q$, 'link a bug to an epic');
select lives_ok($q$select public.set_work_item_hierarchy(pg_temp.id('bug2'), 'TASK', null)$q$, 'change bug to a standalone task');

-- Every writer goes through the guard (as the table owner).
reset role;
select throws_ok($q$update public.work_items set parent_id = pg_temp.id('subtask') where id = pg_temp.id('task')$q$, '22023', 'invalid_parent', 'circular relationship rejected');
select throws_ok($q$insert into public.work_items (project_id, type, title, parent_id, reporter_id) values (pg_temp.id('p2'), 'TASK', 'X', pg_temp.id('story'), pg_temp.uid('pm2'))$q$, '22023', 'invalid_parent', 'cross-project parent rejected for every writer');
select throws_ok($q$update public.work_items set issue_key = 'WIA-99' where id = pg_temp.id('epic')$q$, '22023', 'work_item_identity_immutable', 'issue keys are immutable');
select throws_ok($q$update public.work_items set project_id = pg_temp.id('p2') where id = pg_temp.id('bug2')$q$, '22023', 'work_item_identity_immutable', 'items cannot move between projects');
select throws_ok($q$delete from public.work_items where id = pg_temp.id('bug2')$q$, '23514', 'Work items cannot be deleted. Archive the work item instead.', 'hard delete blocked');
select throws_ok($q$truncate public.work_items cascade$q$, '23514', 'Work items cannot be deleted. Archive the work item instead.', 'truncate blocked');
insert into public.work_items (project_id, issue_number, issue_key, type, title, reporter_id) values (pg_temp.id('p2'), 1, 'WIB-1', 'TASK', 'Spoof', pg_temp.uid('pm2'));
select is((select issue_key from public.work_items where title = 'Spoof'), 'WIB-2', 'supplied numbers/keys are ignored; the counter assigns the next one');

-- -----------------------------------------------------------------------------
-- Workflow
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('dev1'); set local role authenticated; -- dev1 is assigned to 'task' (TODO)
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'DONE')$q$, '22023', 'invalid_transition', 'TODO -> DONE is not allowed');
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_PROGRESS')$q$, 'assignee: TODO -> IN_PROGRESS');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'BLOCKED')$q$, '22023', 'blocked_reason_required', 'blocking needs a reason (8F2)');
select lives_ok($q$select public.execute_work_item(pg_temp.id('task'), 'block', 'IN_PROGRESS', 'Waiting for API keys')$q$, 'assignee: IN_PROGRESS -> BLOCKED with a reason');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'TODO')$q$, '22023', 'invalid_transition', 'BLOCKED returns only to its previous status');
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_PROGRESS')$q$, 'BLOCKED -> previous status');
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_REVIEW')$q$, 'IN_PROGRESS -> IN_REVIEW');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'DONE')$q$, '42501', 'forbidden', 'developer cannot approve their own work (8F2)');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_PROGRESS')$q$, '42501', 'forbidden', 'developer cannot reject a review (8F2)');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.execute_work_item(pg_temp.id('task'), 'reject', 'IN_REVIEW', 'Missing tests')$q$, 'review rejected -> IN_PROGRESS (manager, with reason)');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_REVIEW')$q$, 'back to review');
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'DONE')$q$, 'IN_REVIEW -> DONE (manager approves)');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_PROGRESS')$q$, '42501', 'forbidden', 'developer cannot reopen (manager-only)');
reset role;
select ok((select completed_at is not null and blocked_from_status is null from public.work_items where id = pg_temp.id('task')), 'completed_at set on DONE');
select throws_ok($q$update public.work_items set status = 'DONE' where id = pg_temp.id('story')$q$, '22023', 'invalid_transition', 'workflow enforced for every writer');
select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.change_work_item_status(pg_temp.id('task'), 'IN_PROGRESS')$q$, 'manager reopens');
select lives_ok($q$select public.change_work_item_status(pg_temp.id('subtask'), 'CANCELLED')$q$, 'manager cancels');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('story'), 'IN_PROGRESS')$q$, '22023', 'invalid_transition', 'BACKLOG -> IN_PROGRESS is not allowed');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'Starts done', p_status => 'DONE')$q$, '22023', 'invalid_status', 'new items start in BACKLOG or TODO');
reset role;
select ok((select completed_at is null from public.work_items where id = pg_temp.id('task')), 'completed_at cleared on reopen');

-- -----------------------------------------------------------------------------
-- Developer permissions and assignment restrictions
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('dev1'); set local role authenticated;
select lives_ok($q$insert into t_ids values ('devtask', public.create_work_item(pg_temp.id('p1'), 'TASK', 'Dev task', p_assignee_id => pg_temp.uid('dev1')))$q$, 'developer creates a task assigned to self');
select lives_ok($q$insert into t_ids values ('devbug', public.create_work_item(pg_temp.id('p1'), 'BUG', 'Dev bug'))$q$, 'developer creates an unassigned bug');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'STORY', 'No')$q$, '42501', 'forbidden', 'developer cannot create stories');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'EPIC', 'No')$q$, '42501', 'forbidden', 'developer cannot create epics');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'SUBTASK', 'No', p_parent_id => pg_temp.id('task'))$q$, '42501', 'forbidden', 'developer cannot create subtasks');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'No', p_assignee_id => pg_temp.uid('dev2'))$q$, '42501', 'forbidden', 'developer cannot assign others');
select lives_ok($q$select public.update_work_item(pg_temp.id('devtask'), 'Dev task renamed', 'Notes')$q$, 'assignee edits their item');
select throws_ok($q$select public.update_work_item(pg_temp.id('devbug'), 'Nope')$q$, '42501', 'forbidden', 'developer cannot edit unassigned work');
select throws_ok($q$select public.change_work_item_status(pg_temp.id('devbug'), 'TODO')$q$, '42501', 'forbidden', 'developer cannot move unassigned work');
select throws_ok($q$select public.change_work_item_priority(pg_temp.id('devtask'), 'high')$q$, '42501', 'forbidden', 'developer cannot change priority');
select throws_ok($q$select public.assign_work_item(pg_temp.id('devbug'), pg_temp.uid('dev1'))$q$, '42501', 'forbidden', 'developer cannot assign');
select throws_ok($q$select public.set_work_item_hierarchy(pg_temp.id('devtask'), 'TASK', pg_temp.id('story'))$q$, '42501', 'forbidden', 'developer cannot change the parent');
select throws_ok($q$select public.archive_work_item(pg_temp.id('devtask'))$q$, '42501', 'forbidden', 'developer cannot archive');
select throws_ok($q$select public.add_project_member(pg_temp.id('p1'), pg_temp.uid('dev3'))$q$, '42501', 'forbidden', 'developer still cannot manage membership');
select throws_ok($q$update public.work_items set title = 'x' where id = pg_temp.id('devtask')$q$, '42501', null, 'no direct updates');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.assign_work_item(pg_temp.id('devbug'), pg_temp.uid('dev2'))$q$, 'PM assigns a member developer');
select throws_ok($q$select public.assign_work_item(pg_temp.id('devbug'), pg_temp.uid('dev3'))$q$, '22023', 'invalid_assignee', 'non-member developer cannot be assigned');
select throws_ok($q$select public.assign_work_item(pg_temp.id('devbug'), pg_temp.uid('dev_off'))$q$, '22023', 'invalid_assignee', 'inactive developer cannot be assigned');
select throws_ok($q$select public.assign_work_item(pg_temp.id('devbug'), pg_temp.uid('pm1'))$q$, '22023', 'invalid_assignee', 'Project Managers are not assignees');
select lives_ok($q$select public.change_work_item_priority(pg_temp.id('devbug'), 'high')$q$, 'PM changes priority');
select lives_ok($q$select public.assign_work_item(pg_temp.id('devbug'), null)$q$, 'PM unassigns');
select throws_ok($q$select public.update_work_item(pg_temp.id('devtask'), 'Bad dates', null, '2027-02-01', '2027-01-01')$q$, '22023', 'invalid_date_range', 'date order validated');
select throws_ok($q$select public.update_work_item(pg_temp.id('devtask'), 'Bad', null, null, null, 1001)$q$, '22023', 'invalid_estimate', 'estimate bounded');
select throws_ok($q$select public.update_work_item(pg_temp.id('devtask'), ' ')$q$, '22023', 'invalid_title', 'title required');

-- -----------------------------------------------------------------------------
-- Visibility and unauthorized access
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('dev1'); set local role authenticated;
select is((select count(*)::int from public.list_work_items(pg_temp.id('p1'), p_page_size => 100)), 9, 'member developer lists project items');
select is((select count(*)::int from public.work_items where project_id in (pg_temp.id('p1'), pg_temp.id('p2'))), 9, 'RLS: member sees only their project');
select throws_ok($q$select * from public.list_work_items(pg_temp.id('p2'))$q$, 'P0002', 'project_not_found', 'developer cannot list another project');

reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select * from public.list_work_items(pg_temp.id('p1'))$q$, 'P0002', 'project_not_found', 'unrelated PM cannot list');
select is((select count(*)::int from public.get_work_item(pg_temp.id('epic'))), 0, 'unrelated PM cannot read an item');
select throws_ok($q$select public.update_work_item(pg_temp.id('epic'), 'Taken')$q$, 'P0002', 'work_item_not_found', 'unrelated PM cannot edit');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'Intrude')$q$, 'P0002', 'project_not_found', 'unrelated PM cannot create');
select throws_ok($q$select public.set_work_item_hierarchy(pg_temp.id('other'), 'STORY', pg_temp.id('epic'))$q$, '22023', 'invalid_parent', 'cannot attach to a parent in a project you cannot see');
select is((select count(*)::int from public.work_items where project_id = pg_temp.id('p1')), 0, 'RLS hides other projects');

reset role; select pg_temp.login('dev3'); set local role authenticated;
select is((select count(*)::int from public.get_work_item(pg_temp.id('epic'))), 0, 'non-member developer cannot read');
select throws_ok($q$select * from public.list_work_item_children(pg_temp.id('epic'))$q$, 'P0002', 'work_item_not_found', 'non-member cannot read children');

reset role; select pg_temp.login('sa'); set local role authenticated;
select is((select count(*)::int from public.list_work_items(pg_temp.id('p2'))), 2, 'Super Admin reads any project');
select lives_ok($q$select public.change_work_item_priority(pg_temp.id('other'), 'low')$q$, 'Super Admin manages any project');

-- -----------------------------------------------------------------------------
-- Filtering, search, sort, pagination, children, parent options
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select is((select count(*)::int from public.list_work_items(pg_temp.id('p1'), p_type => 'BUG')), 2, 'type filter');
select is((select count(*)::int from public.list_work_items(pg_temp.id('p1'), p_status => 'CANCELLED')), 1, 'status filter');
select is((select issue_key from public.list_work_items(pg_temp.id('p1'), p_priority => 'critical')), 'WIA-5', 'priority filter');
select is((select array_agg(issue_key order by issue_key) from public.list_work_items(pg_temp.id('p1'), p_assignee_id => pg_temp.uid('dev1'))), array['WIA-3','WIA-8'], 'assignee filter');
select ok((select bool_and(assignee_id is null) from public.list_work_items(pg_temp.id('p1'), p_unassigned => true)), 'unassigned filter');
select is((select issue_key from public.list_work_items(pg_temp.id('p1'), p_search => 'wia-3')), 'WIA-3', 'search by issue key');
select is((select issue_key from public.list_work_items(pg_temp.id('p1'), p_search => '4')), 'WIA-4', 'search by issue number');
select is((select issue_key from public.list_work_items(pg_temp.id('p1'), p_search => 'CVV')), 'WIA-4', 'search by title');
select is((select array_agg(issue_key) from public.list_work_items(pg_temp.id('p1'), p_sort => 'key_asc', p_page => 2, p_page_size => 3)), array['WIA-4','WIA-5','WIA-6'], 'sort and pagination');
select is((select total_count::int from public.list_work_items(pg_temp.id('p1'), p_page_size => 1) limit 1), 9, 'total count');
select throws_ok($q$select * from public.list_work_items(pg_temp.id('p1'), p_sort => 'id; drop')$q$, '22023', 'invalid_sort', 'sort is allow-listed');
select is((select child_count from public.list_work_items(pg_temp.id('p1'), p_search => 'WIA-2')), 2, 'child count (task and moved task)');
select set_eq($q$select issue_key from public.list_work_item_children(pg_temp.id('task'))$q$, array['WIA-4','WIA-5'], 'children listed');
select set_eq($q$select type::text from public.list_work_item_parent_options(pg_temp.id('p1'), 'SUBTASK')$q$, array['TASK'], 'subtask parents are tasks only');
select ok(not exists (select 1 from public.list_work_item_parent_options(pg_temp.id('p1'), 'TASK', null, pg_temp.id('story')) where id = pg_temp.id('story')), 'excluded item is not offered');

-- -----------------------------------------------------------------------------
-- Archive / restore
-- -----------------------------------------------------------------------------
select throws_ok($q$select public.archive_work_item(pg_temp.id('epic'))$q$, '55000', 'has_active_children', 'cannot archive an item with active children');
select lives_ok($q$select public.archive_work_item(pg_temp.id('devbug'))$q$, 'archive a leaf');
select throws_ok($q$select public.update_work_item(pg_temp.id('devbug'), 'Edit')$q$, '55000', 'work_item_archived', 'archived items are read-only');
select is((select count(*)::int from public.list_work_items(pg_temp.id('p1'), p_archived => true)), 1, 'archived view');
select is((select count(*)::int from public.list_work_items(pg_temp.id('p1'), p_page_size => 100)), 8, 'archived items hidden from the active list');
select lives_ok($q$select public.restore_work_item(pg_temp.id('devbug'))$q$, 'restore');
insert into t_ids values ('after', public.create_work_item(pg_temp.id('p1'), 'TASK', 'After archive'));
select is((select issue_key from public.get_work_item(pg_temp.id('after'))), 'WIA-10', 'numbers are never reused');
select is((select array_agg(issue_key) from public.list_work_items(pg_temp.id('p1'), p_search => 'WIA-1')), array['WIA-1'], 'a full key is an exact match (not WIA-10)');
select lives_ok($q$select public.archive_project(pg_temp.id('p1'))$q$, 'archive the project');
select throws_ok($q$select public.create_work_item(pg_temp.id('p1'), 'TASK', 'Late')$q$, '55000', 'project_archived', 'archived project: no new items');
select throws_ok($q$select public.change_work_item_priority(pg_temp.id('after'), 'low')$q$, '55000', 'project_archived', 'archived project: items read-only');
select lives_ok($q$select public.restore_project(pg_temp.id('p1'))$q$, 'restore the project');

-- -----------------------------------------------------------------------------
-- Audit and activity
-- -----------------------------------------------------------------------------
reset role;
select set_eq($q$select distinct action from private.project_audit_log where project_id = pg_temp.id('p1') and action like 'WORK_ITEM_%'$q$,
  array['WORK_ITEM_CREATED','WORK_ITEM_UPDATED','WORK_ITEM_TYPE_CHANGED','WORK_ITEM_PARENT_CHANGED','WORK_ITEM_ASSIGNED',
        'WORK_ITEM_PRIORITY_CHANGED','WORK_ITEM_STATUS_CHANGED','WORK_ITEM_ARCHIVED','WORK_ITEM_RESTORED',
        'WORK_ITEM_BLOCKED','WORK_ITEM_REVIEW_REJECTED'], 'every work item event is audited');
select is((select count(*)::int from private.project_audit_log where action = 'WORK_ITEM_CREATED' and project_id = pg_temp.id('p1')), 10, 'one creation event per item');
select ok((select bool_and(work_item_id is not null) from private.project_audit_log where action like 'WORK_ITEM_%'), 'work item events carry work_item_id');
select is((select count(*)::int from private.project_audit_log where work_item_id = pg_temp.id('task')
            and action in ('WORK_ITEM_STATUS_CHANGED', 'WORK_ITEM_BLOCKED', 'WORK_ITEM_REVIEW_REJECTED')), 8, 'every status transition audited');
select is((select actor_id from private.project_audit_log where work_item_id = pg_temp.id('devtask') and action = 'WORK_ITEM_CREATED'), pg_temp.uid('dev1'), 'audit actor is the caller');
select throws_ok($q$insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values) values (pg_temp.uid('sa'), pg_temp.id('p1'), 'WORK_ITEM_CREATED', '{}', '{}')$q$, '23514', null, 'work item events require a work item id');

select pg_temp.login('dev1'); set local role authenticated;
create temporary table t_feed on commit drop as
  select * from public.list_project_activity(pg_temp.id('p1'), p_limit => 101);
create temporary table t_item_feed on commit drop as
  select * from public.list_project_activity(pg_temp.id('p1'), p_limit => 101, p_work_item_id => pg_temp.id('task'));
reset role;
select ok((select bool_and(work_item_key = 'WIA-3') from t_item_feed), 'work item filter returns only that item');
select is((select count(*)::int from t_item_feed), 9, 'item history: creation + 8 status changes (failed attempts are not recorded)');
select is((select row(subject_name, previous_subject_name) from t_feed where action = 'WORK_ITEM_ASSIGNED' and work_item_key = 'WIA-9' and subject_name is not null),
          row('P8D dev2'::text, null::text), 'assignment resolves the assignee name');
select is((select row(subject_name, previous_subject_name) from t_feed where action = 'WORK_ITEM_PARENT_CHANGED' and work_item_key = 'WIA-7'),
          row('WIA-2'::text, null::text), 'parent change resolves issue keys');
select is((select changes from t_feed where action = 'WORK_ITEM_STATUS_CHANGED' and work_item_key = 'WIA-4'),
          '[{"field":"status","from":"BACKLOG","to":"CANCELLED"}]'::jsonb, 'status change details');
select ok(not exists (select 1 from t_feed where changes::text like '%Secret%' or changes::text like '%Notes%'), 'description text never returned');
select ok(not exists (select 1 from t_feed where changes::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-'), 'no raw ids in changes');
select ok((select changes @> '[{"field":"estimate","to":"3.5"}]'::jsonb from t_feed where action = 'WORK_ITEM_CREATED' and work_item_key = 'WIA-7'), 'numeric fields are returned as text');

select * from finish();
rollback;
