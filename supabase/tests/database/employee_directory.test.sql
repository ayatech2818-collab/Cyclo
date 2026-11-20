-- Phase 2: employee read RPCs and profile column grants.
-- Runs inside a transaction that is rolled back; no data is left behind.
-- Run: npx supabase test db   (local stack only)
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(53);

-- -----------------------------------------------------------------------------
-- Fixtures (created as postgres; the auth trigger creates DEVELOPER profiles)
-- -----------------------------------------------------------------------------
create temporary table t_users (key text primary key, id uuid not null) on commit drop;
grant select on t_users to authenticated, anon;

insert into t_users (key, id) values
  ('sa',       '00000000-0000-4000-a000-000000000001'),
  ('sa2',      '00000000-0000-4000-a000-000000000002'),
  ('pm',       '00000000-0000-4000-a000-000000000003'),
  ('dev',      '00000000-0000-4000-a000-000000000004'),
  ('dev2',     '00000000-0000-4000-a000-000000000005'),
  ('inactive', '00000000-0000-4000-a000-000000000006'),
  ('pm_off',   '00000000-0000-4000-a000-000000000007');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.key || '@cyclo.test', '', now(), '{}'::jsonb,
       -- Metadata must never influence roles.
       '{"role":"SUPER_ADMIN"}'::jsonb, now(), now()
  from t_users as u;

update public.profiles set full_name = 'Alice Admin',      role = 'SUPER_ADMIN',     employee_code = 'AT-001', is_git_organizer = true where id = '00000000-0000-4000-a000-000000000001';
update public.profiles set full_name = 'Bob Backup',       role = 'SUPER_ADMIN',     employee_code = 'AT-002' where id = '00000000-0000-4000-a000-000000000002';
update public.profiles set full_name = 'Paula Manager',    role = 'PROJECT_MANAGER', employee_code = 'AT-003', invited_by = '00000000-0000-4000-a000-000000000001' where id = '00000000-0000-4000-a000-000000000003';
update public.profiles set full_name = 'Dan 100% Dev',     employee_code = 'AT_004' where id = '00000000-0000-4000-a000-000000000004';
update public.profiles set full_name = 'Dora Developer',   employee_code = 'AT-005' where id = '00000000-0000-4000-a000-000000000005';
update public.profiles set full_name = 'Ian Inactive',     is_active = false where id = '00000000-0000-4000-a000-000000000006';
update public.profiles set full_name = 'Pete Former PM',   role = 'PROJECT_MANAGER', is_active = false where id = '00000000-0000-4000-a000-000000000007';

create function pg_temp.act_as(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.act_anonymous() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end;
$$;

-- -----------------------------------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------------------------------
select is(
  (select rolcanlogin or rolsuper or rolbypassrls from pg_roles where rolname = 'cyclo_employee_api'),
  false, 'owner role cannot log in, is not superuser and does not bypass RLS');

select is(
  (select count(*)::int from pg_auth_members a
     where a.roleid = 'cyclo_employee_api'::regrole and (a.set_option or a.inherit_option)),
  0, 'no role can SET or INHERIT the owner role');

select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'private'::regnamespace
      and p.proname in ('list_employees','get_employee','admin_get_employee','get_my_profile','require_employee_actor')
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'cyclo_employee_api'
      and p.proconfig @> array['search_path=""']),
  5, 'private RPCs are SECURITY DEFINER, owned by the API role, with empty search_path');

select is(
  (select count(*)::int from pg_proc p
    where p.proname in ('list_employees','get_employee','admin_get_employee','get_my_profile')
      and p.prorettype = 'public.profiles'::regtype),
  0, 'no RPC returns the profiles row type');

select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('list_employees','get_employee','admin_get_employee','get_my_profile')
      and not p.prosecdef),
  4, 'public wrappers are SECURITY INVOKER');

select ok(not has_function_privilege('anon', 'public.list_employees(text, public.app_role, boolean, integer, integer)', 'execute'), 'anon cannot execute list_employees');
select ok(not has_function_privilege('anon', 'public.get_my_profile()', 'execute'), 'anon cannot execute get_my_profile');
select ok(not has_function_privilege('authenticated', 'private.require_employee_actor(public.app_role[])', 'execute'), 'authenticated cannot call the authorization helper');
select ok(not has_function_privilege('authenticated', 'private.request_user_id()', 'execute'), 'authenticated cannot call the identity bridge');
select ok(not has_table_privilege('cyclo_employee_api', 'public.profiles', 'update'), 'API role has no UPDATE on profiles');

select ok(not has_column_privilege('authenticated', 'public.profiles', 'invited_by', 'select'),       'invited_by is not directly readable');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'onboarded_at', 'select'),     'onboarded_at is not directly readable');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'is_git_organizer', 'select'), 'is_git_organizer is not directly readable');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'select'),       'created_at is not directly readable');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'select'),       'updated_at is not directly readable');
select ok(has_column_privilege('authenticated', 'public.profiles', 'full_name', 'update'),            'own full_name UPDATE grant preserved');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'),             'role UPDATE still not granted');

-- -----------------------------------------------------------------------------
-- Super Admin
-- -----------------------------------------------------------------------------
select pg_temp.act_as('sa');

select is((select count(*)::int from public.list_employees(p_page_size => 100)), 7, 'SA lists all employees');
select is((select max(total_count)::int from public.list_employees(p_page_size => 2)), 7, 'total_count reflects all matches');
select is((select count(*)::int from public.list_employees(p_page => 4, p_page_size => 2)), 1, 'last page is partial');
select is((select count(*)::int from public.list_employees(p_page => 5, p_page_size => 2)), 0, 'page past the end is empty');
select is(
  (select array_agg(full_name) from public.list_employees(p_page_size => 3)),
  array['Alice Admin', 'Bob Backup', 'Dan 100% Dev'],
  'stable sort by name');
select is((select count(*)::int from public.list_employees(p_is_active => false)), 2, 'filter inactive');
select is((select count(*)::int from public.list_employees(p_role => 'SUPER_ADMIN')), 2, 'filter by role');
select is((select count(*)::int from public.list_employees(p_role => 'PROJECT_MANAGER', p_is_active => true)), 1, 'combined filters');

select is((select full_name from public.list_employees(p_search => '  paula ')), 'Paula Manager', 'search name, trimmed, case-insensitive');
select is((select full_name from public.list_employees(p_search => 'dora@cyclo')), null::text, 'search email does not match unrelated');
select is((select full_name from public.list_employees(p_search => 'dev2@cyclo')), 'Dora Developer', 'search by email');
select is((select full_name from public.list_employees(p_search => 'at-003')), 'Paula Manager', 'search by employee code');
select is((select count(*)::int from public.list_employees(p_search => '%')), 1, '% is matched literally');
-- Unescaped, 'T_00' would match every AT-00x code.
select is((select count(*)::int from public.list_employees(p_search => 'T_00')), 1, '_ is matched literally');
select is((select count(*)::int from public.list_employees(p_search => '')), 7, 'blank search returns everyone');

select throws_ok($$ select * from public.list_employees(p_page_size => 0) $$,   '22023', 'invalid_page_size', 'page size below range rejected');
select throws_ok($$ select * from public.list_employees(p_page_size => 101) $$, '22023', 'invalid_page_size', 'page size above range rejected');
select throws_ok($$ select * from public.list_employees(p_page => 0) $$,        '22023', 'invalid_page',      'page below range rejected');
select throws_ok($$ select * from public.list_employees(p_search => repeat('x', 101)) $$, '22023', 'invalid_search', 'overlong search rejected');

select is(
  (select is_git_organizer::text || ':' || invited_by_name from public.admin_get_employee('00000000-0000-4000-a000-000000000003')),
  'false:Alice Admin', 'SA reads administrative detail');

-- -----------------------------------------------------------------------------
-- Project Manager
-- -----------------------------------------------------------------------------
select pg_temp.act_as('pm');

select is((select count(*)::int from public.list_employees(p_page_size => 100)), 7, 'PM lists all employees, including inactive');
select is((select full_name from public.get_employee('00000000-0000-4000-a000-000000000006')), 'Ian Inactive', 'PM reads directory detail');
select throws_ok($$ select * from public.admin_get_employee('00000000-0000-4000-a000-000000000001') $$, '42501', 'forbidden', 'PM cannot read administrative detail');
select throws_ok($$ select invited_by from public.profiles $$, '42501', null, 'PM cannot select administrative columns directly');
select is((select count(*)::int from public.profiles), 1, 'PM direct table read still limited to own row');

-- -----------------------------------------------------------------------------
-- Developer
-- -----------------------------------------------------------------------------
select pg_temp.act_as('dev');

select throws_ok($$ select * from public.list_employees() $$, '42501', 'forbidden', 'developer cannot list employees');
select throws_ok($$ select * from public.get_employee('00000000-0000-4000-a000-000000000005') $$, '42501', 'forbidden', 'developer cannot read another employee');
select throws_ok($$ select * from private.list_employees(null, null, null, 1, 25) $$, '42501', 'forbidden', 'direct private call enforces the same rule');
select is((select full_name from public.get_my_profile()), 'Dan 100% Dev', 'developer reads own profile');
select is((select role::text from public.get_my_profile()), 'DEVELOPER', 'auth metadata did not elevate role');
select is(
  (select array_agg(id::text) from public.profiles),
  array['00000000-0000-4000-a000-000000000004'],
  'existing auth projection still works on own row');

update public.profiles set full_name = 'Dan Updated' where id = '00000000-0000-4000-a000-000000000004';
select is((select full_name from public.get_my_profile()), 'Dan Updated', 'own full_name update still works');

-- -----------------------------------------------------------------------------
-- Inactive and anonymous callers
-- -----------------------------------------------------------------------------
select pg_temp.act_as('pm_off');
select throws_ok($$ select * from public.list_employees() $$, '42501', 'forbidden', 'inactive PM cannot list employees');
select throws_ok($$ select * from public.get_my_profile() $$, '42501', 'forbidden', 'inactive employee cannot read own profile RPC');

reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok($$ select * from public.get_my_profile() $$, '42501', 'unauthenticated', 'missing JWT subject rejected');

reset role;
select pg_temp.act_anonymous();
select throws_ok($$ select * from public.list_employees() $$, '42501', null, 'anon cannot execute RPCs');

select * from finish();
rollback;
