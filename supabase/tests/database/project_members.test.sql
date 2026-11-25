-- Phase 8B: project team membership, developer visibility, RLS and audit.
-- Runs inside a transaction that is rolled back; no data is left behind.
-- Run: npx supabase test db   (local stack only)
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- -----------------------------------------------------------------------------
-- Fixtures (as postgres)
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;
insert into t_users (key, id) values
  ('sa',      '81000000-0000-4000-a000-000000000001'),
  ('pm1',     '81000000-0000-4000-a000-000000000002'),
  ('pm2',     '81000000-0000-4000-a000-000000000003'),
  ('dev1',    '81000000-0000-4000-a000-000000000004'),
  ('dev2',    '81000000-0000-4000-a000-000000000005'),
  ('dev3',    '81000000-0000-4000-a000-000000000006'),
  ('dev_off', '81000000-0000-4000-a000-000000000007');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'p8b-' || u.key || '@pgtap.test', '', '{}', '{"role":"SUPER_ADMIN"}', now(), now()
  from t_users u;

update public.profiles set is_active = true, full_name = 'P8B ' || (select key from t_users t where t.id = profiles.id)
 where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN'     where id = '81000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('81000000-0000-4000-a000-000000000002', '81000000-0000-4000-a000-000000000003');
update public.profiles set is_active = false        where id = '81000000-0000-4000-a000-000000000007';

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;

create temporary table t_projects (key text primary key, id uuid) on commit drop;
grant select, insert on t_projects to authenticated;

reset role; select pg_temp.login('pm1'); set local role authenticated;
insert into t_projects values ('alpha', public.create_project('P8B Alpha', 'PBALPHA', 'high'));
insert into t_projects values ('beta',  public.create_project('P8B Beta',  'PBBETA',  'low'));
reset role; select pg_temp.login('pm2'); set local role authenticated;
insert into t_projects values ('gamma', public.create_project('P8B Gamma', 'PBGAMMA', 'medium'));
reset role;

create function pg_temp.pid(p_key text) returns uuid language sql as $$ select id from t_projects where key = p_key $$;

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select has_table('public', 'project_members', 'project_members table exists');
select col_is_unique('public', 'project_members', array['project_id', 'profile_id'], 'unique (project_id, profile_id)');
select fk_ok('public', 'project_members', 'project_id', 'public', 'projects', 'id', 'project FK');
select fk_ok('public', 'project_members', 'profile_id', 'public', 'profiles', 'id', 'profile FK');
select has_index('public', 'project_members', 'project_members_profile_id_idx', 'profile index for visibility lookups');
select ok(not has_table_privilege('authenticated', 'public.project_members', 'insert'), 'no direct INSERT for employees');
select ok(not has_table_privilege('authenticated', 'public.project_members', 'delete'), 'no direct DELETE for employees');
select ok(not has_table_privilege('authenticated', 'public.project_members', 'update'), 'no direct UPDATE for employees');
select ok(not has_table_privilege('service_role', 'public.project_members', 'insert'), 'no INSERT for service_role');
select ok(not has_table_privilege('cyclo_project_api', 'public.project_members', 'update'), 'RPC owner cannot update memberships');
select ok(not has_function_privilege('anon', 'public.add_project_member(uuid,uuid)', 'execute'), 'anon cannot add members');
select is((select pg_get_userbyid(proowner)::text from pg_proc where oid = 'private.list_projects(text,public.project_status,public.project_priority,boolean,text,integer,integer)'::regprocedure),
          'cyclo_project_api', 'list_projects still owned by the restricted role');

-- -----------------------------------------------------------------------------
-- Assigned PM manages their own team
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select set_eq($q$select id from public.list_assignable_developers(pg_temp.pid('alpha'), 'P8B') $q$,
  array[pg_temp.uid('dev1'), pg_temp.uid('dev2'), pg_temp.uid('dev3')], 'selector offers only active developers');
select lives_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev1'))$q$, 'assigned PM adds a developer');
select lives_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev2'))$q$, 'assigned PM adds a second developer');
select lives_ok($q$select public.add_project_member(pg_temp.pid('beta'), pg_temp.uid('dev1'))$q$, 'a developer can belong to several projects');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev1'))$q$, '23505', 'duplicate_member', 'duplicate membership rejected');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev_off'))$q$, '22023', 'invalid_member', 'inactive developer rejected');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('pm2'))$q$, '22023', 'invalid_member', 'Project Manager cannot be a developer member');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('pm1'))$q$, '22023', 'invalid_member', 'assigned PM is never duplicated as a member');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('sa'))$q$, '22023', 'invalid_member', 'Super Admin cannot be a developer member');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), gen_random_uuid())$q$, '22023', 'invalid_member', 'unknown profile rejected');
select set_eq($q$select id from public.list_assignable_developers(pg_temp.pid('alpha'), 'P8B') $q$,
  array[pg_temp.uid('dev3')], 'selector excludes existing members');
select is((select count(*)::int from public.list_assignable_developers(pg_temp.pid('alpha'), 'p8b dev3')), 1, 'search matches names case-insensitively');
select is((select count(*)::int from public.list_assignable_developers(pg_temp.pid('alpha'), 'p8b_dev3')), 0, 'LIKE wildcards are literal');
select is((select count(*)::int from public.list_assignable_developers(pg_temp.pid('alpha'), 'p8b-dev3@')), 1, 'search matches email');
select set_eq($q$select profile_id from public.list_project_members(pg_temp.pid('alpha'))$q$,
  array[pg_temp.uid('dev1'), pg_temp.uid('dev2')], 'PM lists the team');
select is((select added_by from public.list_project_members(pg_temp.pid('alpha')) where profile_id = pg_temp.uid('dev1')),
  pg_temp.uid('pm1'), 'added_by is the caller');
select lives_ok($q$select public.remove_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev2'))$q$, 'assigned PM removes a developer');
select throws_ok($q$select public.remove_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev2'))$q$, 'P0002', 'member_not_found', 'removing a non-member fails');

-- -----------------------------------------------------------------------------
-- Other PMs cannot manage or read the team
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm2'); set local role authenticated;
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev3'))$q$, 'P0002', 'project_not_found', 'other PM cannot add members');
select throws_ok($q$select public.remove_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev1'))$q$, 'P0002', 'project_not_found', 'other PM cannot remove members');
select throws_ok($q$select * from public.list_project_members(pg_temp.pid('alpha'))$q$, 'P0002', 'project_not_found', 'other PM cannot read the team');
select throws_ok($q$select * from public.list_assignable_developers(pg_temp.pid('alpha'))$q$, 'P0002', 'project_not_found', 'other PM cannot search candidates');
select is((select count(*)::int from public.project_members where project_id = pg_temp.pid('alpha')), 0, 'RLS hides other PMs'' team rows');
select lives_ok($q$select public.add_project_member(pg_temp.pid('gamma'), pg_temp.uid('dev2'))$q$, 'PM manages their own project');

-- -----------------------------------------------------------------------------
-- Super Admin manages every team
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
select lives_ok($q$select public.add_project_member(pg_temp.pid('gamma'), pg_temp.uid('dev3'))$q$, 'Super Admin adds to any project');
select lives_ok($q$select public.remove_project_member(pg_temp.pid('gamma'), pg_temp.uid('dev3'))$q$, 'Super Admin removes from any project');
select is((select count(*)::int from public.list_project_members(pg_temp.pid('gamma'))), 1, 'Super Admin reads any team');
select is((select count(*)::int from public.project_members where project_id in (select id from t_projects)), 3, 'Super Admin reads all membership rows');

-- -----------------------------------------------------------------------------
-- Developers: visibility only through membership; no management
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('dev1'); set local role authenticated;
select set_eq($q$select project_key from public.list_projects(p_search => 'P8B')$q$, array['PBALPHA','PBBETA'], 'developer lists only member projects');
select set_eq($q$select project_key from public.projects where project_key like 'PB%'$q$, array['PBALPHA','PBBETA'], 'RLS: developer reads only member projects');
select is((select project_key from public.get_project(pg_temp.pid('alpha'))), 'PBALPHA', 'developer opens a member project');
select is((select count(*)::int from public.get_project(pg_temp.pid('gamma'))), 0, 'developer cannot open another team''s project');
select is((select count(*)::int from public.list_project_members(pg_temp.pid('alpha'))), 1, 'developer reads their own team');
select throws_ok($q$select * from public.list_project_members(pg_temp.pid('gamma'))$q$, 'P0002', 'project_not_found', 'developer cannot read another team');
select is((select count(*)::int from public.project_members where project_id = pg_temp.pid('gamma')), 0, 'RLS hides other teams'' rows');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev3'))$q$, '42501', 'forbidden', 'developer cannot add members');
select throws_ok($q$select public.remove_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev1'))$q$, '42501', 'forbidden', 'developer cannot remove themselves');
select throws_ok($q$select * from public.list_assignable_developers(pg_temp.pid('alpha'))$q$, '42501', 'forbidden', 'developer cannot search candidates');
select throws_ok($q$insert into public.project_members (project_id, profile_id, added_by) values (pg_temp.pid('gamma'), pg_temp.uid('dev1'), pg_temp.uid('dev1'))$q$, '42501', null, 'developer cannot add themselves directly');
select throws_ok($q$delete from public.project_members where profile_id = pg_temp.uid('dev1')$q$, '42501', null, 'developer cannot delete memberships directly');
select throws_ok($q$select public.update_project(pg_temp.pid('alpha'), 'Hijack', 'active', 'low')$q$, '42501', 'forbidden', 'member developer still cannot edit the project');

reset role; select pg_temp.login('dev3'); set local role authenticated;
select is((select count(*)::int from public.list_projects(p_search => 'P8B')), 0, 'developer without membership sees nothing');

-- Removal revokes access immediately.
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.remove_project_member(pg_temp.pid('beta'), pg_temp.uid('dev1'))$q$, 'PM removes dev1 from beta');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select set_eq($q$select project_key from public.list_projects(p_search => 'P8B')$q$, array['PBALPHA'], 'removed developer loses access');

-- Inactive member: no access while inactive.
reset role;
update public.profiles set is_active = false where id = pg_temp.uid('dev2');
select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.list_projects()$q$, '42501', 'forbidden', 'inactive member is denied');
reset role;
update public.profiles set is_active = true where id = pg_temp.uid('dev2');

-- -----------------------------------------------------------------------------
-- Archived projects, table guards, Phase 8A rules preserved
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm1'); set local role authenticated;
select lives_ok($q$select public.archive_project(pg_temp.pid('alpha'))$q$, 'archive alpha');
select throws_ok($q$select public.add_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev3'))$q$, '55000', 'project_archived', 'archived team cannot change (add)');
select throws_ok($q$select public.remove_project_member(pg_temp.pid('alpha'), pg_temp.uid('dev1'))$q$, '55000', 'project_archived', 'archived team cannot change (remove)');
reset role; select pg_temp.login('dev1'); set local role authenticated;
select is((select project_key from public.list_projects(p_archived => true, p_search => 'P8B')), 'PBALPHA', 'member sees archived project in archived view');

reset role;
select throws_ok($q$insert into public.project_members (project_id, profile_id, added_by) values (pg_temp.pid('beta'), pg_temp.uid('pm2'), pg_temp.uid('sa'))$q$, '23514', 'invalid_member', 'trigger rejects non-developers for every writer');
select throws_ok($q$insert into public.project_members (project_id, profile_id, added_by) values (pg_temp.pid('gamma'), pg_temp.uid('dev2'), pg_temp.uid('sa'))$q$, '23505', null, 'unique constraint prevents duplicates for every writer');
select throws_ok($q$update public.project_members set profile_id = pg_temp.uid('dev3') where profile_id = pg_temp.uid('dev2')$q$, '22023', 'project_member_immutable', 'memberships are immutable');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select is((select count(*)::int from public.list_projects(p_search => 'PBGAMMA')), 0, 'PM visibility unchanged (assigned only)');
reset role; select pg_temp.login('sa'); set local role authenticated;
select is((select count(*)::int from public.list_projects(p_search => 'P8B', p_page_size => 100)), 2, 'Super Admin still sees every active project');

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
reset role;
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_MEMBER_ADDED' and project_id in (select id from t_projects)), 5, 'each add audited');
select is((select count(*)::int from private.project_audit_log where action = 'PROJECT_MEMBER_REMOVED' and project_id in (select id from t_projects)), 3, 'each removal audited (failures not audited)');
select is((select actor_id from private.project_audit_log where action = 'PROJECT_MEMBER_ADDED' and project_id = pg_temp.pid('gamma') and new_values->>'profile_id' = pg_temp.uid('dev3')::text),
          pg_temp.uid('sa'), 'audit records the actor and member');

select * from finish();
rollback;
