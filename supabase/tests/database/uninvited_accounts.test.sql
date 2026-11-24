-- Phase 7 H1: accounts created without a database invitation never get access
-- on their own. Transactional; everything is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Actors: 1 active Super Admin (fixture, activated explicitly).
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','70000000-0000-4000-a000-000000000001','authenticated','authenticated','h1-admin@pgtap.test','',now(),'{}','{}',now(),now());
update public.profiles set is_active=true, role='SUPER_ADMIN' where id='70000000-0000-4000-a000-000000000001';

-- ---------------------------------------------------------------------------
-- Uninvited accounts: inactive DEVELOPER profile, metadata ignored
-- ---------------------------------------------------------------------------
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','70000000-0000-4000-a000-000000000002','authenticated','authenticated','h1-uninvited@pgtap.test','',now(),
       '{"role":"SUPER_ADMIN","is_active":true}','{"role":"SUPER_ADMIN","is_active":true,"is_git_organizer":true}',now(),now());

select is((select row(role,is_active,is_git_organizer,requires_onboarding,invited_by,onboarded_at)::text from public.profiles where id='70000000-0000-4000-a000-000000000002'),
  row('DEVELOPER'::public.app_role,false,false,false,null::uuid,null::timestamptz)::text,'uninvited account gets an inactive default DEVELOPER profile');
select ok(not exists(select 1 from private.employee_invitations where auth_user_id='70000000-0000-4000-a000-000000000002'),'no invitation is created or linked');

reset role; select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-a000-000000000002","role":"authenticated"}',true); set local role authenticated;
select is(private.current_app_role(),null,'uninvited account has no application role');
select throws_ok($q$select * from public.get_my_profile()$q$,'42501','forbidden','own profile RPC denied');
select throws_ok($q$select * from public.list_employees()$q$,'42501','forbidden','directory denied');
select throws_ok($q$select public.update_my_profile('Self Activated')$q$,'42501','forbidden','self-service profile edit denied');
select throws_ok($q$select public.set_my_avatar('emoji','fox')$q$,'42501','forbidden','avatar selection denied');
select throws_ok($q$select * from public.get_employee_avatars(array['70000000-0000-4000-a000-000000000002']::uuid[])$q$,'42501','forbidden','avatar read denied');
select throws_ok($q$update public.profiles set is_active=true where id='70000000-0000-4000-a000-000000000002'$q$,'42501',null,'cannot activate itself directly');
select throws_ok($q$select public.accept_employee_invitation()$q$,null,null,'cannot accept a non-existent invitation');
select throws_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','70000000-0000-4000-a000-000000000002/11111111-2222-4333-8444-555555555555.png','70000000-0000-4000-a000-000000000002')$q$,'42501',null,'cannot upload');
select is((select count(*)::int from public.profiles where id<>'70000000-0000-4000-a000-000000000002'),0,'sees no other profile rows');
reset role;
select is((select is_active from public.profiles where id='70000000-0000-4000-a000-000000000002'),false,'still inactive after all attempts');

-- A second insert path (e.g. Admin API with app metadata) behaves the same.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','70000000-0000-4000-a000-000000000003','authenticated','authenticated','h1-admin-api@pgtap.test','','{"provider":"email","role":"SUPER_ADMIN"}','{}',now(),now());
select is((select row(role,is_active)::text from public.profiles where id='70000000-0000-4000-a000-000000000003'),row('DEVELOPER'::public.app_role,false)::text,'app metadata cannot assign role or status');

-- An Auth invitation without a database invitation is still rejected outright.
select throws_ok($q$insert into auth.users(instance_id,id,aud,role,email,encrypted_password,invited_at,raw_user_meta_data,created_at,updated_at) values('00000000-0000-0000-0000-000000000000','70000000-0000-4000-a000-000000000009','authenticated','authenticated','h1-rogue-invite@pgtap.test','',now(),'{}',now(),now())$q$,'42501','invalid_invitation','Auth invite without database invitation rejected');

-- ---------------------------------------------------------------------------
-- Activation paths still work
-- ---------------------------------------------------------------------------
-- Super Admin activates an uninvited account through the audited Phase 4 RPC.
select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-a000-000000000001","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$select public.admin_set_employee_active('70000000-0000-4000-a000-000000000002',true)$q$,'super admin can activate an uninvited account');
reset role;
select is((select row(role,is_active)::text from public.profiles where id='70000000-0000-4000-a000-000000000002'),row('DEVELOPER'::public.app_role,true)::text,'activated as DEVELOPER only');
select ok(exists(select 1 from private.employee_audit_log where target_employee_id='70000000-0000-4000-a000-000000000002' and action='EMPLOYEE_ACTIVATED' and actor_id='70000000-0000-4000-a000-000000000001'),'activation audited');
select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-a000-000000000002","role":"authenticated"}',true); set local role authenticated;
select is((select role::text from public.get_my_profile()),'DEVELOPER','activated account now has access');
reset role;

-- Owner-only Super Admin provisioning is unchanged.
select is(private.provision_super_admin('h1-admin-api@pgtap.test'),'70000000-0000-4000-a000-000000000003'::uuid,'provision_super_admin still works');
select is((select row(role,is_active)::text from public.profiles where id='70000000-0000-4000-a000-000000000003'),row('SUPER_ADMIN'::public.app_role,true)::text,'provisioned account is an active Super Admin');
select ok(not has_function_privilege('authenticated','private.provision_super_admin(text)','execute'),'provisioning is not callable by API users');
select ok(not has_function_privilege('authenticated','private.handle_new_auth_user()','execute'),'trigger function not callable by API users');

-- ---------------------------------------------------------------------------
-- Invited accounts are unchanged: inactive until atomic onboarding completion
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"70000000-0000-4000-a000-000000000001","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$select public.admin_create_employee_invitation('h1-invitee@pgtap.test','H1 Invitee','PROJECT_MANAGER')$q$,'super admin invites');
reset role;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,invited_at,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','70000000-0000-4000-a000-000000000004','authenticated','authenticated','h1-invitee@pgtap.test','',now(),now(),'{"role":"SUPER_ADMIN"}',now(),now());
select is((select row(role,is_active,requires_onboarding)::text from public.profiles where id='70000000-0000-4000-a000-000000000004'),
  row('PROJECT_MANAGER'::public.app_role,false,true)::text,'invitee gets the invited role, inactive, pending onboarding');

-- ---------------------------------------------------------------------------
-- Trigger definition guarantees
-- ---------------------------------------------------------------------------
select ok((select prosecdef from pg_proc where oid='private.handle_new_auth_user'::regproc),'trigger function is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='private.handle_new_auth_user'::regproc),'trigger function pins an empty search_path');
select ok((select prosrc !~ '(raw_user_meta_data|raw_app_meta_data|user_metadata|app_metadata)' from pg_proc where oid='private.handle_new_auth_user'::regproc),'trigger never reads Auth metadata');
select ok((select prosrc ~ $re$'DEVELOPER',false,false$re$ from pg_proc where oid='private.handle_new_auth_user'::regproc),'default profile is created inactive');

select * from finish(); rollback;
