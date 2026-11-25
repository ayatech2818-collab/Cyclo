begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','60000000-0000-4000-a000-000000000001','authenticated','authenticated','phase5-admin@pgtap.test','hash',now(),'{}',now(),now()),
('00000000-0000-0000-0000-000000000000','60000000-0000-4000-a000-000000000002','authenticated','authenticated','phase5-pm@pgtap.test','hash',now(),'{}',now(),now()),
('00000000-0000-0000-0000-000000000000','60000000-0000-4000-a000-000000000003','authenticated','authenticated','phase5-dev@pgtap.test','hash',now(),'{"role":"SUPER_ADMIN"}',now(),now());
-- Phase 7 H1: uninvited accounts are created inactive; fixtures are activated explicitly.
update public.profiles set is_active=true where id in ('60000000-0000-4000-a000-000000000001','60000000-0000-4000-a000-000000000002','60000000-0000-4000-a000-000000000003');
update public.profiles set role='SUPER_ADMIN' where id='60000000-0000-4000-a000-000000000001';
update public.profiles set role='PROJECT_MANAGER' where id='60000000-0000-4000-a000-000000000002';
select ok(not has_function_privilege('anon','public.admin_create_employee_invitation(text,text,public.app_role)','execute'),'anon denied');
select ok(not has_table_privilege('authenticated','private.employee_invitations','select'),'no direct invitation reads');
select ok(not has_table_privilege('authenticated','private.employee_invitations','insert'),'no direct invitation inserts');
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000002"}',true); set local role authenticated;
select throws_ok($q$select public.admin_create_employee_invitation('no@pgtap.test','No','DEVELOPER')$q$,'42501','forbidden','PM denied');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000003"}',true); set local role authenticated;
select throws_ok($q$select public.admin_create_employee_invitation('no@pgtap.test','No','DEVELOPER')$q$,'42501','forbidden','developer metadata cannot invite');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000001"}',true); set local role authenticated;
select lives_ok($q$select public.admin_create_employee_invitation(' Invited@pgtap.test ',' Invited Admin ','SUPER_ADMIN')$q$,'admin creates invitation');
select throws_ok($q$select public.admin_create_employee_invitation('invited@pgtap.test','Other','DEVELOPER')$q$,'23505','invitation_exists','duplicate pending denied');
select throws_ok($q$select public.admin_create_employee_invitation('phase5-dev@pgtap.test','Other','DEVELOPER')$q$,'23505','employee_exists','existing employee denied');
reset role;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,invited_at,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','60000000-0000-4000-a000-000000000004','authenticated','authenticated','invited@pgtap.test','',now(),now(),'{"role":"DEVELOPER"}',now(),now());
select is((select role::text from public.profiles where id='60000000-0000-4000-a000-000000000004'),'SUPER_ADMIN','trusted invitation role beats metadata');
select is((select is_active from public.profiles where id='60000000-0000-4000-a000-000000000004'),false,'invitee inactive');
select is((select invited_by from public.profiles where id='60000000-0000-4000-a000-000000000004'),'60000000-0000-4000-a000-000000000001'::uuid,'inviter preserved');
select is((select onboarded_at from public.profiles where id='60000000-0000-4000-a000-000000000001'),null::timestamptz,'existing admin not backfilled');
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000001"}',true);set local role authenticated;
select throws_ok($q$select public.admin_set_employee_active('60000000-0000-4000-a000-000000000004',true)$q$,'23514','onboarding_required','Phase 4 activation cannot bypass onboarding');
select throws_ok($q$select public.admin_set_employee_role('60000000-0000-4000-a000-000000000004','DEVELOPER')$q$,'23514','invitation_profile_protected','Phase 4 role change cannot replace invitation authority');
reset role;
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000004"}',true);set local role authenticated;
select throws_ok($q$select public.list_employees()$q$,'42501','forbidden','incomplete invited admin cannot use employee RPC');
select lives_ok($q$select public.accept_employee_invitation()$q$,'confirmed invitee accepts');
select throws_ok($q$select public.accept_employee_invitation()$q$,'22023','invitation_replayed','accept replay denied');
select throws_ok($q$select public.start_employee_onboarding()$q$,'22023','password_required','password required');
reset role; update auth.users set encrypted_password='test-password-hash' where id='60000000-0000-4000-a000-000000000004';
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000004"}',true);set local role authenticated;
select lives_ok($q$select public.start_employee_onboarding()$q$,'password permits onboarding');
select lives_ok($q$select public.complete_employee_onboarding(' Completed Name ')$q$,'complete onboarding');
select throws_ok($q$select public.complete_employee_onboarding('Replay')$q$,'42501','invalid_invitation','complete replay denied');
select lives_ok($q$select public.list_employees()$q$,'completed admin can use normal RPCs');
reset role;
select is((select is_active and not requires_onboarding and onboarded_at is not null from public.profiles where id='60000000-0000-4000-a000-000000000004'),true,'completion activated atomically');
select is((select full_name from public.profiles where id='60000000-0000-4000-a000-000000000004'),'Completed Name','name trimmed');
select is((select role::text from public.profiles where id='60000000-0000-4000-a000-000000000004'),'SUPER_ADMIN','role preserved after completion');
select is((select count(*)::integer from private.employee_audit_log where invitation_id in(select id from private.employee_invitations where email='invited@pgtap.test')),4,'create accept start complete audited');
select throws_ok($q$update private.employee_invitations set assigned_role='DEVELOPER' where email='invited@pgtap.test'$q$,'23514','invitation_fields_immutable','invitation role immutable');
select * from finish();rollback;
