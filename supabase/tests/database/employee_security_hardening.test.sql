-- Phase 4 security review regression: grants, direct RPC validation, audit.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname in ('lock_employee_admin_target','admin_update_employee_details')
 and pg_get_userbyid(p.proowner)='cyclo_employee_api' and p.prosecdef
 and p.proconfig @> array['search_path=""']),2,'hardened functions retain owner, definer and safe search_path');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname='is_valid_employee_avatar_url'
 and pg_get_userbyid(p.proowner)='cyclo_employee_api' and not p.prosecdef and p.provolatile='i'
 and p.proconfig @> array['search_path=""']),1,'validator is private immutable invoker with safe owner/search_path');
select ok(not has_function_privilege('anon','private.is_valid_employee_avatar_url(text)','EXECUTE'),'anon cannot invoke internal validator');
select ok(not has_function_privilege('authenticated','private.is_valid_employee_avatar_url(text)','EXECUTE'),'authenticated cannot invoke internal validator');
select ok(not has_function_privilege('service_role','private.is_valid_employee_avatar_url(text)','EXECUTE'),'service_role cannot invoke internal validator');
select ok(not has_function_privilege('authenticated','private.lock_employee_admin_target(uuid)','EXECUTE'),'authenticated cannot invoke lock helper');
select ok(not has_schema_privilege('cyclo_employee_api','private','CREATE'),'temporary schema CREATE revoked');
select is((select count(*)::integer from pg_auth_members where roleid='cyclo_employee_api'::regrole and (set_option or inherit_option)),0,'temporary role membership revoked');
select ok(not has_table_privilege('cyclo_employee_api','public.profiles','UPDATE'),'API still has no table-wide UPDATE');
select ok(not has_column_privilege('cyclo_employee_api','public.profiles','email','UPDATE'),'email remains outside allowlist');
select ok(not has_table_privilege('cyclo_employee_api','private.employee_audit_log','DELETE'),'API cannot delete audits');
select ok(not has_table_privilege('authenticated','private.employee_audit_log','SELECT'),'authenticated cannot read audits');
select is((select count(*)::integer from pg_trigger where tgrelid='public.profiles'::regclass
 and tgname in ('profiles_protect_last_active_super_admin','profiles_prevent_truncate') and tgenabled='A'),2,'last-admin triggers remain ALWAYS enabled');
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',('50000000-0000-4000-a000-'||lpad(n::text,12,'0'))::uuid,
'authenticated','authenticated','security-fix-'||n||'@pgtap.test','','{}','{}',now(),now() from generate_series(1,2)n;
update public.profiles set role='SUPER_ADMIN' where id='50000000-0000-4000-a000-000000000001';
select set_config('request.jwt.claims','{"sub":"50000000-0000-4000-a000-000000000001","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com/avatar.png')$q$,'accept standard');
select lives_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com')$q$,'accept bare host');
select lives_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com:443/avatar.png')$q$,'accept explicit port');
select lives_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name',null)$q$,'accept NULL');
select lives_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','')$q$,'accept empty');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://:443/')$q$,'22023','invalid_avatar_url','reject missing hostname');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.test:99999/')$q$,'22023','invalid_avatar_url','reject out of range port');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','http://example.com/avatar.png')$q$,'22023','invalid_avatar_url','reject http');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://user:pass@example.com/')$q$,'22023','invalid_avatar_url','reject credentials');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https:///avatar.png')$q$,'22023','invalid_avatar_url','reject triple slash');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com/a b')$q$,'22023','invalid_avatar_url','reject whitespace');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com:0/')$q$,'22023','invalid_avatar_url','reject zero port');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com:/')$q$,'22023','invalid_avatar_url','reject empty port');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://[::::]/')$q$,'22023','invalid_avatar_url','reject bad IPv6');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name',' https://example.com/')$q$,'22023','invalid_avatar_url','reject leading whitespace');
select throws_ok($q$select public.admin_update_employee_details('50000000-0000-4000-a000-000000000002','Name','https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$q$,'22023','invalid_avatar_url','reject too long');
reset role;
select is((select count(*)::integer from private.employee_audit_log where target_employee_id='50000000-0000-4000-a000-000000000002'),4,'successful changes audited; failed/no-op inputs produce no audit');
select ok(not exists(select 1 from private.employee_audit_log where target_employee_id='50000000-0000-4000-a000-000000000002' and new_values ? 'avatar_url'),'avatar audit never stores raw URLs');
select * from finish(); rollback;
