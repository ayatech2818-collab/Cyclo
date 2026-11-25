-- Phase 8A: projects table, RLS, RPC authorization, validation, archive and audit.
-- Runs inside a transaction that is rolled back; no data is left behind.
-- Run: npx supabase test db   (local stack only)
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures (as postgres). Uninvited auth users start as inactive DEVELOPERs.
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',     '80000000-0000-4000-a000-000000000001'),
  ('pm1',    '80000000-0000-4000-a000-000000000002'),
  ('pm2',    '80000000-0000-4000-a000-000000000003'),
  ('dev',    '80000000-0000-4000-a000-000000000004'),
  ('pm_off', '80000000-0000-4000-a000-000000000005');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'p8a-' || u.key || '@pgtap.test', '', '{}', '{"role":"SUPER_ADMIN"}', now(), now()
  from t_users u;

update public.profiles set is_active = true, full_name = 'P8A ' || (select key from t_users t where t.id = profiles.id)
 where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN'     where id = '80000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('80000000-0000-4000-a000-000000000002',
                                                                 '80000000-0000-4000-a000-000000000003',
                                                                 '80000000-0000-4000-a000-000000000005');
update public.profiles set is_active = false where id = '80000000-0000-4000-a000-000000000005';

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;

create temporary table t_projects (key text primary key, id uuid) on commit drop;
grant select, insert on t_projects to authenticated;

-- -----------------------------------------------------------------------------
-- Privileges and structure
-- -----------------------------------------------------------------------------
select has_table('public', 'projects', 'projects table exists');
select ok(not has_function_privilege('anon', 'public.create_project(text,text,public.project_priority,text,date,date,uuid)', 'execute'), 'anon cannot create projects');
select ok(not has_function_privilege('anon', 'public.list_projects(text,public.project_status,public.project_priority,boolean,text,integer,integer)', 'execute'), 'anon cannot list projects');
select ok(not has_table_privilege('authenticated', 'public.projects', 'insert'), 'no direct INSERT for employees');
select ok(not has_table_privilege('authenticated', 'public.projects', 'update'), 'no direct UPDATE for employees');
select ok(not has_table_privilege('authenticated', 'public.projects', 'delete'), 'no direct DELETE for employees');
select ok(not has_table_privilege('service_role', 'public.projects', 'delete'), 'no DELETE even for service_role');
select ok(not has_column_privilege('cyclo_project_api', 'public.projects', 'project_key', 'update'), 'RPC owner cannot change project keys');
select ok(not has_column_privilege('cyclo_project_api', 'public.profiles', 'role', 'update'), 'RPC owner cannot change profiles');
select ok(not has_function_privilege('authenticated', 'private.lock_managed_project(uuid)', 'execute'), 'lock helper is not callable');
select is((select rolbypassrls or rolcanlogin from pg_roles where rolname = 'cyclo_project_api'), false, 'owner role is NOLOGIN without BYPASSRLS');

-- -----------------------------------------------------------------------------
-- Creation
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
select lives_ok($q$insert into t_projects values ('sa_web', public.create_project('  Web Platform  ', ' web ', 'high', 'Customer portal', '2026-12-01', '2027-03-01', '80000000-0000-4000-a000-000000000002'))$q$,
  'Super Admin creates a project for an active PM');
select throws_ok($q$select public.create_project('No PM', 'NOPM', 'low')$q$, '22023', 'invalid_project_manager', 'Super Admin must choose a PM');
select throws_ok($q$select public.create_project('Dev PM', 'DEVPM', 'low', null, null, null, '80000000-0000-4000-a000-000000000004')$q$, '22023', 'invalid_project_manager', 'a developer cannot be PM');
select throws_ok($q$select public.create_project('Off PM', 'OFFPM', 'low', null, null, null, '80000000-0000-4000-a000-000000000005')$q$, '22023', 'invalid_project_manager', 'an inactive PM cannot be PM');
select throws_ok($q$select public.create_project('SA PM', 'SAPM', 'low', null, null, null, '80000000-0000-4000-a000-000000000001')$q$, '22023', 'invalid_project_manager', 'a Super Admin cannot be PM');
select throws_ok($q$select public.create_project('Duplicate', 'WEB', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '23505', 'duplicate_project_key', 'project keys are unique');
select throws_ok($q$select public.create_project('Duplicate', 'Web', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '23505', 'duplicate_project_key', 'keys are normalized to upper case before the uniqueness check');
select throws_ok($q$select public.create_project('Bad key', '1AB', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_project_key', 'key must start with a letter');
select throws_ok($q$select public.create_project('Bad key', 'A-B', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_project_key', 'key must be alphanumeric');
select throws_ok($q$select public.create_project('Bad key', 'ABCDEFGHIJK', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_project_key', 'key is at most 10 characters');
select throws_ok($q$select public.create_project(' ', 'BLANK', 'low', null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_name', 'name is required');
select throws_ok($q$select public.create_project('Dates', 'DATES', 'low', null, '2027-02-01', '2027-01-01', '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_date_range', 'start date cannot exceed target date');
select throws_ok($q$select public.create_project('Prio', 'PRIO', null, null, null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_priority', 'priority is required');
select throws_ok($q$select public.create_project('Desc', 'DESC', 'low', repeat('x', 5001), null, null, '80000000-0000-4000-a000-000000000002')$q$, '22023', 'invalid_description', 'description is bounded');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$insert into t_projects values ('pm1_api', public.create_project('Billing API', 'BILL', 'medium'))$q$, 'Project Manager creates a project');
select lives_ok($q$insert into t_projects values ('pm1_self', public.create_project('Mobile App', 'MOB', 'low', null, null, null, '80000000-0000-4000-a000-000000000002'))$q$, 'Project Manager may name themselves');
select throws_ok($q$select public.create_project('Hijack', 'HIJACK', 'low', null, null, null, '80000000-0000-4000-a000-000000000003')$q$, '42501', 'forbidden', 'Project Manager cannot assign another PM on create');

reset role; select pg_temp.login('pm2'); set local role authenticated;
select lives_ok($q$insert into t_projects values ('pm2_ops', public.create_project('Ops Console', 'OPS', 'critical', null, '2026-12-01', '2026-12-01'))$q$, 'second PM creates a project (equal dates allowed)');

reset role; select pg_temp.login('dev'); set local role authenticated;
select throws_ok($q$select public.create_project('Dev project', 'DEVP', 'low')$q$, '42501', 'forbidden', 'Developer cannot create projects');
select throws_ok($q$insert into public.projects (name, project_key, priority, project_manager_id, created_by) values ('Direct', 'DIRECT', 'low', '80000000-0000-4000-a000-000000000004', '80000000-0000-4000-a000-000000000004')$q$, '42501', null, 'Developer cannot insert directly');

reset role; select pg_temp.login('pm_off'); set local role authenticated;
select throws_ok($q$select public.create_project('Inactive', 'INACT', 'low')$q$, '42501', 'forbidden', 'inactive PM cannot create projects');

reset role; select set_config('request.jwt.claims', '{}', true); set local role authenticated;
select throws_ok($q$select * from public.list_projects()$q$, '42501', 'unauthenticated', 'request without identity is rejected');

reset role;
select is((select project_manager_id from public.projects where id = (select id from t_projects where key = 'pm1_api')),
          '80000000-0000-4000-a000-000000000002'::uuid, 'creating PM is assigned automatically');
select is((select created_by from public.projects where id = (select id from t_projects where key = 'sa_web')),
          '80000000-0000-4000-a000-000000000001'::uuid, 'created_by is the caller, never client-provided');
select is((select row(name, project_key, status::text, priority::text) from public.projects where id = (select id from t_projects where key = 'sa_web')),
          row('Web Platform'::text, 'WEB'::text, 'planning'::text, 'high'::text),'name trimmed, key upper-cased, status defaults to planning');

-- -----------------------------------------------------------------------------
-- Visibility and isolation
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
select is((select count(*)::int from public.list_projects(p_page_size => 100) where project_key in ('WEB','BILL','MOB','OPS')), 4, 'Super Admin lists every project');
select is((select count(*)::int from public.projects where project_key in ('WEB','BILL','MOB','OPS')), 4, 'Super Admin reads every project directly');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select set_eq($q$select project_key from public.list_projects(p_page_size => 100)$q$, array['WEB','BILL','MOB'], 'PM lists only assigned projects');
select set_eq($q$select project_key from public.projects$q$, array['WEB','BILL','MOB'], 'RLS limits direct reads to assigned projects');
select is((select count(*)::int from public.get_project((select id from t_projects where key = 'pm2_ops'))), 0, 'PM cannot read another PM''s project');
select throws_ok($q$select public.update_project((select id from t_projects where key = 'pm2_ops'), 'Taken', 'active', 'low')$q$, 'P0002', 'project_not_found', 'PM cannot update another PM''s project');
select throws_ok($q$select public.archive_project((select id from t_projects where key = 'pm2_ops'))$q$, 'P0002', 'project_not_found', 'PM cannot archive another PM''s project');
select is((select total_count::int from public.list_projects(p_search => 'billing') limit 1), 1, 'search matches name');
select is((select project_key from public.list_projects(p_search => 'mob')), 'MOB', 'search matches key');
select is((select count(*)::int from public.list_projects(p_search => '%')), 0, 'LIKE wildcards are literal');
select is((select project_key from public.list_projects(p_priority => 'high')), 'WEB', 'priority filter');
select is((select array_agg(project_key) from public.list_projects(p_sort => 'name_asc')), array['BILL','MOB','WEB'], 'sort by name');
select is((select array_agg(project_key) from public.list_projects(p_sort => 'priority_desc')), array['WEB','BILL','MOB'], 'sort by priority');
select is((select count(*)::int from public.list_projects(p_page => 2, p_page_size => 2)), 1, 'pagination');
select throws_ok($q$select * from public.list_projects(p_sort => 'id; drop table x')$q$, '22023', 'invalid_sort', 'sort is allow-listed');
select throws_ok($q$select * from public.list_projects(p_page_size => 1000)$q$, '22023', 'invalid_page_size', 'page size is bounded');

reset role; select pg_temp.login('dev'); set local role authenticated;
select is((select count(*)::int from public.list_projects()), 0, 'Developer sees no projects without membership');
select is((select count(*)::int from public.projects), 0, 'Developer reads no project rows directly');
select is((select count(*)::int from public.get_project((select id from t_projects where key = 'pm1_api'))), 0, 'Developer cannot open a project');
select throws_ok($q$select public.update_project((select id from t_projects where key = 'pm1_api'), 'X', 'active', 'low')$q$, '42501', 'forbidden', 'Developer cannot edit projects');
select throws_ok($q$select public.archive_project((select id from t_projects where key = 'pm1_api'))$q$, '42501', 'forbidden', 'Developer cannot archive projects');
select throws_ok($q$select * from public.list_project_manager_options()$q$, '42501', 'forbidden', 'Developer cannot list PM options');

-- -----------------------------------------------------------------------------
-- Updates and PM assignment
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.update_project((select id from t_projects where key = 'pm1_api'), 'Billing API v2', 'active', 'high', 'Invoices', '2026-12-01', null)$q$, 'assigned PM updates their project');
select throws_ok($q$select public.update_project((select id from t_projects where key = 'pm1_api'), 'Billing', 'active', 'high', null, '2027-02-01', '2027-01-01')$q$, '22023', 'invalid_date_range', 'update rejects invalid dates');
select throws_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_api'), '80000000-0000-4000-a000-000000000002')$q$, '42501', 'forbidden', 'PM cannot reassign their own PM');
select throws_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_api'), '80000000-0000-4000-a000-000000000003')$q$, '42501', 'forbidden', 'PM cannot hand a project to another PM');
select throws_ok($q$select * from public.list_project_manager_options()$q$, '42501', 'forbidden', 'PM cannot list PM options');

reset role; select pg_temp.login('sa'); set local role authenticated;
select set_eq($q$select id from public.list_project_manager_options() where id::text like '80000000-%'$q$,
  array['80000000-0000-4000-a000-000000000002'::uuid, '80000000-0000-4000-a000-000000000003'::uuid], 'PM options: active Project Managers only');
select throws_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_self'), '80000000-0000-4000-a000-000000000004')$q$, '22023', 'invalid_project_manager', 'cannot reassign to a developer');
select throws_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_self'), '80000000-0000-4000-a000-000000000005')$q$, '22023', 'invalid_project_manager', 'cannot reassign to an inactive PM');
select lives_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_self'), '80000000-0000-4000-a000-000000000003')$q$, 'Super Admin reassigns the PM');
select lives_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm1_self'), '80000000-0000-4000-a000-000000000003')$q$, 'reassigning to the same PM is a no-op');
select lives_ok($q$select public.update_project((select id from t_projects where key = 'pm2_ops'), 'Ops Console', 'on_hold', 'critical', null, '2026-12-01', '2026-12-01')$q$, 'Super Admin updates any project');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select is((select count(*)::int from public.get_project((select id from t_projects where key = 'pm1_self'))), 0, 'previous PM loses access after reassignment');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select is((select project_key from public.get_project((select id from t_projects where key = 'pm1_self'))), 'MOB', 'new PM gains access after reassignment');

-- -----------------------------------------------------------------------------
-- Archive
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.archive_project((select id from t_projects where key = 'pm1_api'))$q$, 'assigned PM archives their project');
select lives_ok($q$select public.archive_project((select id from t_projects where key = 'pm1_api'))$q$, 'archive is idempotent');
select throws_ok($q$select public.update_project((select id from t_projects where key = 'pm1_api'), 'Billing', 'active', 'high')$q$, '55000', 'project_archived', 'archived projects are read-only');
select is((select count(*)::int from public.list_projects() where project_key = 'BILL'), 0, 'archived projects are hidden from the active list');
select is((select project_key from public.list_projects(p_archived => true)), 'BILL', 'archived view lists archived projects');
select ok((select archived_at is not null from public.get_project((select id from t_projects where key = 'pm1_api'))), 'archived project remains readable');
select lives_ok($q$select public.restore_project((select id from t_projects where key = 'pm1_api'))$q$, 'assigned PM restores their project');
reset role; select pg_temp.login('sa'); set local role authenticated;
select lives_ok($q$select public.archive_project((select id from t_projects where key = 'pm2_ops'))$q$, 'Super Admin archives any project');
select throws_ok($q$select public.assign_project_manager((select id from t_projects where key = 'pm2_ops'), '80000000-0000-4000-a000-000000000002')$q$, '55000', 'project_archived', 'archived projects cannot be reassigned');

-- -----------------------------------------------------------------------------
-- Table-level guarantees (as the table owner)
-- -----------------------------------------------------------------------------
reset role;
select throws_ok($q$delete from public.projects where project_key = 'WEB'$q$, '23514', 'Projects cannot be deleted. Archive the project instead.', 'hard delete is blocked even for the owner');
select throws_ok($q$truncate public.projects cascade$q$, '23514', 'Projects cannot be deleted. Archive the project instead.', 'truncate is blocked');
select throws_ok($q$update public.projects set project_key = 'WEB2' where project_key = 'WEB'$q$, '22023', 'project_key_immutable', 'project keys are immutable');
select throws_ok($q$update public.projects set project_manager_id = '80000000-0000-4000-a000-000000000004' where project_key = 'WEB'$q$, '23514', 'invalid_project_manager', 'trigger rejects a non-PM for every writer');
select throws_ok($q$update public.projects set start_date = '2027-05-01' where project_key = 'WEB'$q$, '23514', null, 'date order is a table constraint');
select lives_ok($q$update public.profiles set is_active = false where id = '80000000-0000-4000-a000-000000000002'$q$, 'deactivating a PM is not blocked by projects');
select lives_ok($q$update public.projects set priority = 'low' where project_key = 'WEB'$q$, 'unrelated edits still work while the PM is inactive');

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_CREATED' and project_id in (select id from t_projects)), 4, 'each creation audited');
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_ARCHIVED' and project_id in (select id from t_projects)), 2, 'archives audited once (idempotent repeat not audited)');
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_RESTORED' and project_id in (select id from t_projects)), 1, 'restore audited');
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_MANAGER_CHANGED' and project_id in (select id from t_projects)), 1, 'PM change audited once (no-op not audited)');
select is((select new_values from private.project_audit_log where action = 'PROJECT_MANAGER_CHANGED' and project_id = (select id from t_projects where key = 'pm1_self')),
          '{"project_manager_id":"80000000-0000-4000-a000-000000000003"}'::jsonb, 'PM change records the new PM');
select is((select actor_id from private.project_audit_log where action = 'PROJECT_UPDATED' and project_id = (select id from t_projects where key = 'pm1_api')),
          '80000000-0000-4000-a000-000000000002'::uuid, 'update audit records the actor');
select is((select array_agg(k order by k) from private.project_audit_log, jsonb_object_keys(new_values) k where action = 'PROJECT_UPDATED' and project_id = (select id from t_projects where key = 'pm1_api')),
          array['description','name','priority','start_date','status'], 'update audit stores only changed fields');
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$insert into private.project_audit_log (actor_id, project_id, action, old_values, new_values) values ('80000000-0000-4000-a000-000000000003', gen_random_uuid(), 'PROJECT_CREATED', '{}', '{}')$q$, '42501', null, 'employees cannot write audit rows');
select throws_ok($q$select * from private.project_audit_log$q$, '42501', null, 'employees cannot read audit rows directly');

reset role;
select * from finish();
rollback;
