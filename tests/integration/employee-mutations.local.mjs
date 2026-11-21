// Real Auth/PostgREST security tests. Refuses non-loopback environments.
// Service credentials are used for disposable fixture setup/cleanup only.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {createClient} from '@supabase/supabase-js';
const url=process.env.API_URL;
if(!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw Error('Local Supabase URL required.');
const key=process.env.PUBLISHABLE_KEY??process.env.ANON_KEY;
const service=process.env.SECRET_KEY??process.env.SERVICE_ROLE_KEY;
if(!key||!service)throw Error('Local Supabase credentials required.');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const setup=createClient(url,service,options),run=randomUUID().slice(0,8),users={};
let safeCleanup=false;
before(async()=>{
 const baseline=await setup.from('profiles').select('id').eq('role','SUPER_ADMIN').eq('is_active',true);
 if(baseline.error||!baseline.data.length)throw Error('An existing local admin is required to clean up test admins safely.');
 safeCleanup=true;
 for(const [name,role,active] of [['sa','SUPER_ADMIN',true],['sa2','SUPER_ADMIN',true],['off','SUPER_ADMIN',false],['pm','PROJECT_MANAGER',true],['dev','DEVELOPER',true]]){
  const email='it4-'+run+'-'+name+'@cyclo.test',password=randomBytes(24).toString('base64url');
  const created=await setup.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{role:'SUPER_ADMIN'}});
  if(created.error)throw created.error;
  const id=created.data.user.id,client=createClient(url,key,options);users[name]={id,client};
  const update=await setup.from('profiles').update({role,is_active:active,full_name:'Phase4 '+run+' '+name}).eq('id',id);if(update.error)throw update.error;
  const login=await client.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 }
});
after(async()=>{
 if(!safeCleanup)return;
 for(const {id,client} of Object.values(users)){
  await client.auth.signOut();
  const demote=await setup.from('profiles').update({role:'DEVELOPER'}).eq('id',id);if(demote.error)throw demote.error;
  const removed=await setup.auth.admin.deleteUser(id);if(removed.error)throw removed.error;
 }
});
const payloads=()=>[
 ['admin_update_employee_details',{p_full_name:' Updated Name ',p_avatar_url:''}],
 ['admin_set_employee_code',{p_employee_code:'IT4-'+run}],
 ['admin_set_employee_role',{p_role:'PROJECT_MANAGER'}],
 ['admin_set_employee_active',{p_is_active:false}],
 ['admin_set_git_organizer',{p_is_git_organizer:true}],
];
test('all mutation endpoints deny anonymous, developer, PM and inactive admin',async()=>{
 const anonymous=createClient(url,key,options);
 for(const client of [anonymous,users.dev.client,users.pm.client,users.off.client])for(const [name,args]of payloads()){
  const result=await client.rpc(name,{p_employee_id:users.dev.id,...args});assert.equal(result.error?.code,'42501',name);
 }
});
test('HTTP RPC does not accept spoofed actor or arbitrary fields',async()=>{
 const args={p_employee_id:users.dev.id,p_employee_code:'SPOOF'};
 for(const extra of [{actor_id:users.sa.id},{p_email:'spoof@test.local'},{p_role:'SUPER_ADMIN'}]){
  const result=await users.dev.client.rpc('admin_set_employee_code',{...args,...extra});assert.ok(result.error);
 }
 const direct=await users.dev.client.from('profiles').update({full_name:'SPOOF'}).eq('id',users.pm.id).select('id');assert.equal(direct.error,null);assert.equal(direct.data.length,0);
 const role=await users.dev.client.from('profiles').update({role:'SUPER_ADMIN'}).eq('id',users.dev.id);assert.equal(role.error?.code,'42501');
});
test('active admin performs all five operations through caller session',async()=>{
 for(const [name,args]of payloads()){
  const result=await users.sa.client.rpc(name,{p_employee_id:users.dev.id,...args});assert.equal(result.error,null,name);assert.equal(result.data[0].id,users.dev.id);assert.equal('secret' in result.data[0],false);
 }
 const denied=await users.dev.client.rpc('get_my_profile');assert.equal(denied.error?.code,'42501');
 const activate=await users.sa.client.rpc('admin_set_employee_active',{p_employee_id:users.dev.id,p_is_active:true});assert.equal(activate.error,null);assert.equal(activate.data[0].onboarded_at,null);
 const own=await users.dev.client.rpc('get_my_profile');assert.equal(own.error,null);
});
test('duplicate codes are rejected and self-management is blocked over HTTP',async()=>{
 const duplicate=await users.sa.client.rpc('admin_set_employee_code',{p_employee_id:users.pm.id,p_employee_code:'IT4-'+run});assert.equal(duplicate.error?.code,'23505');
 const role=await users.sa.client.rpc('admin_set_employee_role',{p_employee_id:users.sa.id,p_role:'DEVELOPER'});assert.equal(role.error?.message,'self_demotion');
 const active=await users.sa.client.rpc('admin_set_employee_active',{p_employee_id:users.sa.id,p_is_active:false});assert.equal(active.error?.message,'self_deactivation');
});
test('PM DTO still excludes Git Organizer and administrative fields',async()=>{
 const detail=await users.pm.client.rpc('get_employee',{p_employee_id:users.dev.id});assert.equal(detail.error,null);
 assert.deepEqual(Object.keys(detail.data[0]).sort(),['avatar_url','email','employee_code','full_name','id','is_active','role']);
 const audit=await users.sa.client.schema('private').from('employee_audit_log').select('id');assert.ok(audit.error);
});
test('concurrent cross-admin demotion permits exactly one winner',async()=>{
 const results=await Promise.all([
 users.sa.client.rpc('admin_set_employee_role',{p_employee_id:users.sa2.id,p_role:'DEVELOPER'}),
 users.sa2.client.rpc('admin_set_employee_role',{p_employee_id:users.sa.id,p_role:'DEVELOPER'})]);
 assert.equal(results.filter(r=>!r.error).length,1);assert.equal(results.find(r=>r.error).error.code,'42501');
});
