-- Phase 6: own profile, avatar selection state, avatar storage policies.
-- Transactional; everything is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Actors: 1 SA, 2 PM, 3 DEV, 4 DEV (other), 5 inactive DEV
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000', ('60000000-0000-4000-a000-'||lpad(n::text,12,'0'))::uuid,
'authenticated','authenticated','phase6-'||n||'@pgtap.test','','{}','{"role":"SUPER_ADMIN"}',now(),now() from generate_series(1,5) n;
-- Phase 7 H1: uninvited accounts are created inactive; fixtures are activated explicitly.
update public.profiles set is_active=true where id::text like '60000000-0000-4000-a000-%';
update public.profiles set role='SUPER_ADMIN' where id='60000000-0000-4000-a000-000000000001';
update public.profiles set role='PROJECT_MANAGER' where id='60000000-0000-4000-a000-000000000002';
update public.profiles set role='DEVELOPER', is_active=false where id='60000000-0000-4000-a000-000000000005';
update public.profiles set full_name='Dev Three', is_git_organizer=false, employee_code='P6-003' where id='60000000-0000-4000-a000-000000000003';

-- ---------------------------------------------------------------------------
-- Schema, bucket and privileges
-- ---------------------------------------------------------------------------
select is((select avatar_kind from public.profiles where id='60000000-0000-4000-a000-000000000003'),'default','new profiles default to the default avatar');
select ok(not exists(select 1 from public.profiles where avatar_kind<>'default' and avatar_path is null and avatar_symbol is null and avatar_kind<>'initials'),'existing rows keep a consistent state');
select is((select public from storage.buckets where id='avatars'),false,'avatars bucket is private');
select is((select file_size_limit from storage.buckets where id='avatars'),2097152::bigint,'avatars bucket limited to 2 MiB');
select is((select allowed_mime_types from storage.buckets where id='avatars'),array['image/jpeg','image/png','image/webp'],'avatars bucket accepts raster images only');
select ok(not exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname ilike '%avatar%' and polcmd='w'),'no UPDATE policy: uploads never overwrite');

select ok(not has_function_privilege('anon','public.'||f,'execute'),'anon denied '||f)
  from unnest(array['get_employee_avatars(uuid[])','update_my_profile(text)','set_my_avatar(text,text)','set_my_avatar_image(text)','remove_my_avatar_image()']) f;
select ok(has_function_privilege('authenticated','public.'||f,'execute'),'authenticated may call '||f)
  from unnest(array['get_employee_avatars(uuid[])','update_my_profile(text)','set_my_avatar(text,text)','set_my_avatar_image(text)','remove_my_avatar_image()']) f;
select ok(not has_function_privilege('authenticated','private.'||f,'execute'),'private helper not callable: '||f)
  from unnest(array['apply_my_avatar(uuid,text,text,text)','lock_self_profile()','my_avatar_object_exists(text)']) f;
select ok(not has_column_privilege('authenticated','public.profiles',c,'update'),'authenticated cannot write '||c||' directly')
  from unnest(array['avatar_kind','avatar_symbol','avatar_path','role','is_active','is_git_organizer','employee_code']) c;
select ok(not has_column_privilege('authenticated','public.profiles',c,'select'),'authenticated cannot read '||c||' directly')
  from unnest(array['avatar_kind','avatar_symbol','avatar_path']) c;
select ok(not has_column_privilege('authenticated','public.profiles','full_name','update'),'direct full_name UPDATE revoked');
select ok(not has_column_privilege('authenticated','public.profiles','avatar_url','update'),'direct avatar_url UPDATE revoked');
select ok(not has_table_privilege('authenticated','public.profiles','update'),'no table-level UPDATE for authenticated');
select ok(not exists(select 1 from pg_policy where polrelid='public.profiles'::regclass and polname='Active employees can update their own profile'),'own-row UPDATE policy removed');
select ok(not has_column_privilege('cyclo_employee_api','public.profiles','email','update'),'RPC owner still cannot change email');

-- ---------------------------------------------------------------------------
-- Constraints (enforced for every writer, including the table owner)
-- ---------------------------------------------------------------------------
select throws_ok($q$update public.profiles set avatar_kind='emoji', avatar_symbol='<b>x</b>' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'unknown emoji identifier rejected');
select throws_ok($q$update public.profiles set avatar_kind='emoji', avatar_symbol=null where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'emoji without identifier rejected');
select throws_ok($q$update public.profiles set avatar_kind='icon', avatar_symbol='fox' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'emoji identifier is not an icon identifier');
select throws_ok($q$update public.profiles set avatar_kind='initials', avatar_symbol='fox' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'symbol only with emoji/icon');
select throws_ok($q$update public.profiles set avatar_kind='svg' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'unknown avatar kind rejected');
select throws_ok($q$update public.profiles set avatar_kind='image' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'image requires a path');
select throws_ok($q$update public.profiles set avatar_path='60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555555.png' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'path must be in the owner''s own folder');
select throws_ok($q$update public.profiles set avatar_path='60000000-0000-4000-a000-000000000004/a.svg' where id='60000000-0000-4000-a000-000000000004'$q$,'23514',null,'path must be <uuid>.<jpg|png|webp>');

-- ---------------------------------------------------------------------------
-- set_my_avatar / update_my_profile as a developer
-- ---------------------------------------------------------------------------
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000003","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$select public.set_my_avatar('emoji','fox')$q$,'developer selects an emoji');
select lives_ok($q$select public.set_my_avatar('emoji','fox')$q$,'repeating the same choice is a no-op');
select lives_ok($q$select public.set_my_avatar('icon','git-branch')$q$,'developer selects an icon');
select lives_ok($q$select public.set_my_avatar('initials')$q$,'developer selects initials');
select throws_ok($q$select public.set_my_avatar('emoji','<img src=x onerror=alert(1)>')$q$,'22023','invalid_avatar_symbol','markup is never accepted as a symbol');
select throws_ok($q$select public.set_my_avatar('emoji','code')$q$,'22023','invalid_avatar_symbol','icon id is not an emoji id');
select throws_ok($q$select public.set_my_avatar('icon','not-an-icon')$q$,'22023','invalid_avatar_symbol','unknown icon rejected');
select throws_ok($q$select public.set_my_avatar('initials','fox')$q$,'22023','invalid_avatar_symbol','symbol not allowed with initials');
select throws_ok($q$select public.set_my_avatar('svg')$q$,'22023','invalid_avatar_kind','unknown kind rejected');
select throws_ok($q$select public.set_my_avatar(null)$q$,'22023','invalid_avatar_kind','null kind rejected');
select throws_ok($q$select public.set_my_avatar('image')$q$,'22023','avatar_image_missing','image needs an uploaded photo');
select lives_ok($q$select public.update_my_profile('  Dev Renamed  ')$q$,'developer renames self');
select throws_ok($q$select public.update_my_profile('   ')$q$,'22023','invalid_full_name','blank name rejected');
select throws_ok($q$select public.update_my_profile(repeat('x',201))$q$,'22023','invalid_full_name','overlong name rejected');
select throws_ok($q$update public.profiles set avatar_kind='emoji', avatar_symbol='fox' where id='60000000-0000-4000-a000-000000000003'$q$,'42501',null,'direct write to avatar columns denied');
select throws_ok($q$update public.profiles set avatar_url='https://evil.test/x.png' where id='60000000-0000-4000-a000-000000000003'$q$,'42501',null,'direct avatar_url write denied');
select throws_ok($q$update public.profiles set full_name='Direct' where id='60000000-0000-4000-a000-000000000003'$q$,'42501',null,'direct full_name write denied');
reset role;
select is((select row(full_name,role,is_active,is_git_organizer,employee_code,avatar_kind,avatar_symbol)::text from public.profiles where id='60000000-0000-4000-a000-000000000003'),
  row('Dev Renamed','DEVELOPER'::public.app_role,true,false,'P6-003','initials',null::text)::text,'only name and avatar changed; role, status, code and Git Organizer untouched');
select is((select count(*)::int from private.employee_audit_log where actor_id='60000000-0000-4000-a000-000000000003' and action='SELF_AVATAR_UPDATED'),3,'each avatar change audited once (no-op skipped)');
select is((select count(*)::int from private.employee_audit_log where actor_id='60000000-0000-4000-a000-000000000003' and action='SELF_PROFILE_UPDATED'),1,'name change audited');
select ok(not exists(select 1 from private.employee_audit_log where action in ('SELF_AVATAR_UPDATED','SELF_PROFILE_UPDATED') and actor_id is distinct from target_employee_id),'self audits always target the actor');
select is((select new_values from private.employee_audit_log where actor_id='60000000-0000-4000-a000-000000000003' and action='SELF_PROFILE_UPDATED'),'{"full_name":"Dev Renamed"}'::jsonb,'name audit stores the trimmed name only');
select throws_ok($q$insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values) values('60000000-0000-4000-a000-000000000001','60000000-0000-4000-a000-000000000003','SELF_AVATAR_UPDATED','{}','{}')$q$,'23514',null,'self audit cannot target someone else');

-- ---------------------------------------------------------------------------
-- Inactive employees
-- ---------------------------------------------------------------------------
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000005","role":"authenticated"}',true); set local role authenticated;
select throws_ok($q$select public.set_my_avatar('emoji','fox')$q$,'42501','forbidden','inactive employee cannot change avatar');
select throws_ok($q$select public.update_my_profile('X')$q$,'42501','forbidden','inactive employee cannot rename');
select throws_ok($q$select * from public.get_employee_avatars(array['60000000-0000-4000-a000-000000000005']::uuid[])$q$,'42501','forbidden','inactive employee cannot read avatars');
select throws_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000005/11111111-2222-4333-8444-555555555555.png','60000000-0000-4000-a000-000000000005')$q$,'42501',null,'inactive employee cannot upload');

-- ---------------------------------------------------------------------------
-- get_employee_avatars visibility
-- ---------------------------------------------------------------------------
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000004","role":"authenticated"}',true); set local role authenticated;
select is((select array_agg(id order by id) from public.get_employee_avatars(array['60000000-0000-4000-a000-000000000003','60000000-0000-4000-a000-000000000004']::uuid[])),
  array['60000000-0000-4000-a000-000000000004']::uuid[],'developer only receives own avatar state');
select throws_ok($q$select * from public.get_employee_avatars(null)$q$,'22023','invalid_employee_ids','null ids rejected');
select throws_ok($q$select * from public.get_employee_avatars(array(select gen_random_uuid() from generate_series(1,101)))$q$,'22023','invalid_employee_ids','more than 100 ids rejected');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000002","role":"authenticated"}',true); set local role authenticated;
select is((select count(*)::int from public.get_employee_avatars(array['60000000-0000-4000-a000-000000000003','60000000-0000-4000-a000-000000000004','60000000-0000-4000-a000-000000000005']::uuid[])),3,'project manager reads directory avatars, including inactive');
select is((select avatar_kind from public.get_employee_avatars(array['60000000-0000-4000-a000-000000000003']::uuid[])),'initials','project manager sees the selection');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000001","role":"authenticated"}',true); set local role authenticated;
select is((select count(*)::int from public.get_employee_avatars(array['60000000-0000-4000-a000-000000000003','60000000-0000-4000-a000-000000000004']::uuid[])),2,'super admin reads directory avatars');

-- ---------------------------------------------------------------------------
-- Storage policies and image attachment
-- ---------------------------------------------------------------------------
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000003","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555551.png','60000000-0000-4000-a000-000000000003')$q$,'employee uploads into own folder');
select throws_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000004/11111111-2222-4333-8444-555555555552.png','60000000-0000-4000-a000-000000000003')$q$,'42501',null,'upload into another employee''s folder denied');
select throws_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000003/avatar.svg','60000000-0000-4000-a000-000000000003')$q$,'42501',null,'arbitrary object names denied');
select throws_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000003/x/11111111-2222-4333-8444-555555555553.png','60000000-0000-4000-a000-000000000003')$q$,'42501',null,'nested folders denied');
select throws_ok($q$select public.set_my_avatar_image('60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555559.png')$q$,'22023','avatar_object_missing','cannot attach an object that was never uploaded');
select throws_ok($q$select public.set_my_avatar_image('60000000-0000-4000-a000-000000000004/11111111-2222-4333-8444-555555555551.png')$q$,'22023','invalid_avatar_path','cannot attach another employee''s path');
select throws_ok($q$select public.set_my_avatar_image('https://evil.test/a.png')$q$,'22023','invalid_avatar_path','URLs are never accepted as paths');
select is((select previous_path from public.set_my_avatar_image('60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555551.png')),null,'first photo attached');
select lives_ok($q$insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555554.webp','60000000-0000-4000-a000-000000000003')$q$,'employee uploads a replacement');
select is((select previous_path from public.set_my_avatar_image('60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555554.webp')),
  '60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555551.png','replacement returns the old path for deletion');
select is((select avatar_path from public.set_my_avatar('emoji','owl')),'60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555554.webp','switching to emoji keeps the photo');
select is((select avatar_kind from public.set_my_avatar('image')),'image','switching back to the kept photo');
select is((select count(*)::int from storage.objects where bucket_id='avatars' and name like '60000000-0000-4000-a000-000000000003/%'),2,'employee reads own objects');

reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000004","role":"authenticated"}',true); set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id='avatars' and name like '60000000-0000-4000-a000-000000000003/%'),0,'developer cannot read another employee''s photo');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000002","role":"authenticated"}',true); set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id='avatars' and name like '60000000-0000-4000-a000-000000000003/%'),2,'project manager can read directory photos');
reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000005","role":"authenticated"}',true); set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id='avatars'),0,'inactive employee reads no photos');

-- An object in the caller's folder but owned by someone else cannot be attached.
reset role;
insert into storage.objects(bucket_id,name,owner_id) values('avatars','60000000-0000-4000-a000-000000000004/11111111-2222-4333-8444-555555555555.png','60000000-0000-4000-a000-000000000003');
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000004","role":"authenticated"}',true); set local role authenticated;
select throws_ok($q$select public.set_my_avatar_image('60000000-0000-4000-a000-000000000004/11111111-2222-4333-8444-555555555555.png')$q$,'22023','avatar_object_missing','object owned by someone else cannot be attached');

reset role; select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000003","role":"authenticated"}',true); set local role authenticated;
select is((select row(avatar_kind,avatar_path,previous_path)::text from public.remove_my_avatar_image()),
  row('default',null::text,'60000000-0000-4000-a000-000000000003/11111111-2222-4333-8444-555555555554.webp')::text,'removing the photo falls back to default and returns the old path');
select is((select previous_path from public.remove_my_avatar_image()),null,'removing again is a no-op');
reset role;
select is((select count(*)::int from private.employee_audit_log where actor_id='60000000-0000-4000-a000-000000000003' and action='SELF_AVATAR_UPDATED'),8,'every attach, switch and removal audited');

-- ---------------------------------------------------------------------------
-- Phase 4 admin avatar management is unchanged and independent
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims','{"sub":"60000000-0000-4000-a000-000000000001","role":"authenticated"}',true); set local role authenticated;
select lives_ok($q$select public.admin_update_employee_details('60000000-0000-4000-a000-000000000003','Dev Renamed','https://cdn.test/a.png')$q$,'super admin still manages avatar_url');
reset role;
select is((select row(avatar_url,avatar_kind)::text from public.profiles where id='60000000-0000-4000-a000-000000000003'),row('https://cdn.test/a.png','default')::text,'admin URL set; employee selection untouched');

select * from finish(); rollback;
