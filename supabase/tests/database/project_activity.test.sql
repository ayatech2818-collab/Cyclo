-- Phase 8C: project activity feed (read RPC over the existing audit log).
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
  ('sa',   '82000000-0000-4000-a000-000000000001'),
  ('pm1',  '82000000-0000-4000-a000-000000000002'),
  ('pm2',  '82000000-0000-4000-a000-000000000003'),
  ('dev1', '82000000-0000-4000-a000-000000000004'),
  ('dev2', '82000000-0000-4000-a000-000000000005');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       'p8c-' || u.key || '@pgtap.test', '', '{}', '{}', now(), now()
  from t_users u;

update public.profiles set is_active = true, full_name = 'P8C ' || (select key from t_users t where t.id = profiles.id)
 where id in (select id from t_users);
update public.profiles set role = 'SUPER_ADMIN'     where id = '82000000-0000-4000-a000-000000000001';
update public.profiles set role = 'PROJECT_MANAGER' where id in ('82000000-0000-4000-a000-000000000002', '82000000-0000-4000-a000-000000000003');
update public.profiles set avatar_kind = 'emoji', avatar_symbol = 'rocket' where id = '82000000-0000-4000-a000-000000000002';

create function pg_temp.login(p_key text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', (select id from t_users where key = p_key), 'role', 'authenticated')::text, true)
$$;
create function pg_temp.uid(p_key text) returns uuid language sql as $$ select id from t_users where key = p_key $$;

create temporary table t_project (id uuid) on commit drop;
grant select, insert on t_project to authenticated;
create function pg_temp.pid() returns uuid language sql as $$ select id from t_project $$;

-- Every row written in this transaction has the same now(); give each step a
-- distinct, increasing time (as the table owner) so ordering is observable.
create temporary table t_seen (id uuid primary key) on commit drop;
create function pg_temp.stamp(p_minute integer) returns void language sql as $$
  update private.project_audit_log
     set created_at = timestamptz '2026-01-01 09:00:00+00' + make_interval(mins => p_minute)
   where project_id = (select id from t_project) and id not in (select id from t_seen);
  insert into t_seen select id from private.project_audit_log where project_id = (select id from t_project)
  on conflict do nothing;
$$;

-- -----------------------------------------------------------------------------
-- Generate every event type through the real RPCs (no fake entries)
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
insert into t_project values (public.create_project('Activity Alpha', 'PCACT', 'high', 'Secret plan text', '2027-01-01', '2027-03-01', pg_temp.uid('pm1')));
reset role; select pg_temp.stamp(1);

select pg_temp.login('pm1'); set local role authenticated;
select public.update_project(pg_temp.pid(), 'Activity Alpha 2', 'active', 'critical', 'New secret text', '2027-01-01', '2027-04-01');
reset role; select pg_temp.stamp(2);

select pg_temp.login('pm1'); set local role authenticated;
select public.add_project_member(pg_temp.pid(), pg_temp.uid('dev1'));
reset role; select pg_temp.stamp(3);

select pg_temp.login('sa'); set local role authenticated;
select public.assign_project_manager(pg_temp.pid(), pg_temp.uid('pm2'));
reset role; select pg_temp.stamp(4);

select pg_temp.login('pm2'); set local role authenticated;
select public.archive_project(pg_temp.pid());
select public.restore_project(pg_temp.pid());
reset role; select pg_temp.stamp(5); -- archive + restore share a timestamp (tie on created_at)

select pg_temp.login('pm2'); set local role authenticated;
select public.add_project_member(pg_temp.pid(), pg_temp.uid('dev2'));
select public.remove_project_member(pg_temp.pid(), pg_temp.uid('dev2'));
reset role; select pg_temp.stamp(6); -- add + remove share a timestamp

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.list_project_activity(uuid,timestamptz,uuid,integer)', 'execute'), 'anon cannot read activity');
select ok(not has_table_privilege('authenticated', 'private.project_audit_log', 'select'), 'employees have no SELECT on the audit table');
select ok(not has_table_privilege('service_role', 'private.project_audit_log', 'select'), 'service_role has no SELECT on the audit table');
select ok(not has_table_privilege('cyclo_project_api', 'private.project_audit_log', 'update'), 'RPC owner cannot change audit rows');
select ok(not has_table_privilege('cyclo_project_api', 'private.project_audit_log', 'delete'), 'RPC owner cannot delete audit rows');
select ok(not has_column_privilege('cyclo_project_api', 'public.profiles', 'avatar_url', 'select'), 'RPC owner cannot read admin avatar URLs');
select ok(not has_column_privilege('cyclo_project_api', 'public.profiles', 'avatar_path', 'select'), 'RPC owner cannot read avatar storage paths');
select ok(not has_function_privilege('authenticated', 'private.project_activity_changes(text,jsonb,jsonb)', 'execute'), 'change helper is not callable');

-- -----------------------------------------------------------------------------
-- Event coverage, actors and content (Super Admin)
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
create temporary table t_feed on commit drop as
  select row_number() over () as pos, a.* from public.list_project_activity(pg_temp.pid(), p_limit => 100) as a;
reset role;

select is((select count(*)::int from t_feed), 8, 'Super Admin reads all 8 entries');
select set_eq($q$select distinct action from t_feed$q$,
  array['PROJECT_CREATED','PROJECT_UPDATED','PROJECT_MANAGER_CHANGED','PROJECT_ARCHIVED',
        'PROJECT_RESTORED','PROJECT_MEMBER_ADDED','PROJECT_MEMBER_REMOVED'], 'every existing event type is returned');
select ok((select bool_and(f.created_at >= n.created_at) from t_feed f join t_feed n on n.pos = f.pos + 1), 'newest first');
select is((select action from t_feed where pos = 8), 'PROJECT_CREATED', 'oldest entry is the creation');

select is((select actor_name from t_feed where action = 'PROJECT_CREATED'), 'P8C sa', 'creation actor is the Super Admin');
select is((select actor_id from t_feed where action = 'PROJECT_UPDATED'), pg_temp.uid('pm1'), 'update actor id');
select is((select row(actor_name, actor_avatar_kind, actor_avatar_symbol) from t_feed where action = 'PROJECT_UPDATED'),
          row('P8C pm1'::text, 'emoji'::text, 'rocket'::text), 'actor name and avatar choice');
select is((select actor_name from t_feed where action = 'PROJECT_ARCHIVED'), 'P8C pm2', 'archive actor');

select is((select subject_name from t_feed where action = 'PROJECT_MEMBER_ADDED' and actor_id = pg_temp.uid('pm1')), 'P8C dev1', 'added member name resolved');
select is((select subject_name from t_feed where action = 'PROJECT_MEMBER_REMOVED'), 'P8C dev2', 'removed member name resolved');
select is((select row(previous_subject_name, subject_name) from t_feed where action = 'PROJECT_MANAGER_CHANGED'),
          row('P8C pm1'::text, 'P8C pm2'::text), 'PM change shows previous and new PM');

select is((select changes from t_feed where action = 'PROJECT_UPDATED'),
  '[{"field":"name","from":"Activity Alpha","to":"Activity Alpha 2"},
    {"field":"status","from":"planning","to":"active"},
    {"field":"priority","from":"high","to":"critical"},
    {"field":"target_date","from":"2027-03-01","to":"2027-04-01"},
    {"field":"description"}]'::jsonb, 'update lists only changed fields, description without text');
select ok((select changes @> '[{"field":"project_key","to":"PCACT"},{"field":"priority","to":"high"},{"field":"description"}]'::jsonb from t_feed where action = 'PROJECT_CREATED'),
  'creation lists key, priority and description presence');
select is((select changes from t_feed where action = 'PROJECT_ARCHIVED'), '[]'::jsonb, 'archive has no field changes');
select ok(not exists (select 1 from t_feed where changes::text like '%secret%'), 'description text is never returned');
select ok(not exists (select 1 from t_feed where changes::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-'), 'no profile ids inside changes');
select ok(not exists (select 1 from t_feed where changes::text like '%archived_at%'), 'archived_at values are not returned');

-- -----------------------------------------------------------------------------
-- Cursor pagination: no duplicates, nothing missing (including timestamp ties)
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('sa'); set local role authenticated;
create temporary table t_paged (pos serial, id uuid) on commit drop;
do $$
declare
  v_at timestamptz;
  v_id uuid;
  v_count integer;
begin
  loop
    with page as (
      select a.id, a.created_at from public.list_project_activity((select id from t_project), v_at, v_id, 3) as a
    ), ins as (
      insert into t_paged (id) select page.id from page order by page.created_at desc, page.id desc returning 1
    )
    select count(*) into v_count from ins;
    exit when v_count < 3;
    select a.created_at, a.id into v_at, v_id
      from public.list_project_activity((select id from t_project), v_at, v_id, 3) as a
     order by a.created_at asc, a.id asc limit 1;
  end loop;
end;
$$;
reset role;
select is((select count(*)::int from t_paged), 8, 'pages of 3 return all 8 entries');
select is((select count(distinct id)::int from t_paged), 8, 'no duplicates across pages');
select is((select array_agg(id order by pos) from t_paged), (select array_agg(id order by pos) from t_feed), 'paged order equals single-page order');

reset role; select pg_temp.login('sa'); set local role authenticated;
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid(), now(), null)$q$, '22023', 'invalid_cursor', 'cursor needs both parts');
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid(), p_limit => 500)$q$, '22023', 'invalid_limit', 'limit is bounded');
select is((select count(*)::int from public.list_project_activity(pg_temp.pid(), timestamptz '2026-01-01 09:00:00+00', '00000000-0000-0000-0000-000000000000', 10)), 0, 'cursor before the first entry returns nothing');

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
reset role; select pg_temp.login('pm2'); set local role authenticated;
select is((select count(*)::int from public.list_project_activity(pg_temp.pid(), p_limit => 100)), 8, 'assigned PM reads the full history');

reset role; select pg_temp.login('dev1'); set local role authenticated;
select is((select count(*)::int from public.list_project_activity(pg_temp.pid(), p_limit => 100)), 8, 'member developer reads the history');
select throws_ok($q$select * from private.project_audit_log$q$, '42501', null, 'member developer has no direct audit access');

reset role; select pg_temp.login('pm1'); set local role authenticated;
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid())$q$, 'P0002', 'project_not_found', 'former/unrelated PM is denied');

reset role; select pg_temp.login('dev2'); set local role authenticated;
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid())$q$, 'P0002', 'project_not_found', 'removed (non-member) developer is denied');

reset role; select set_config('request.jwt.claims', '{}', true); set local role authenticated;
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid())$q$, '42501', 'unauthenticated', 'request without identity is denied');

reset role;
update public.profiles set is_active = false where id = pg_temp.uid('dev1');
select pg_temp.login('dev1'); set local role authenticated;
select throws_ok($q$select * from public.list_project_activity(pg_temp.pid())$q$, '42501', 'forbidden', 'inactive member is denied');

reset role;
select * from finish();
rollback;
