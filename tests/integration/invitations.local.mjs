// Local-only real Auth, Mailpit, callback and onboarding lifecycle checks.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {before,after,test} from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
import {localSql,startLocalSql,pollUntil} from '../helpers/local-postgres.mjs';
const url=process.env.API_URL;
if(!url||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw Error('Local Supabase required');
const key=process.env.PUBLISHABLE_KEY??process.env.ANON_KEY,secret=process.env.SECRET_KEY??process.env.SERVICE_ROLE_KEY;
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(url,secret,options),run=randomUUID().slice(0,8),people={},invites=[],mailIds=new Set();
const app='http://127.0.0.1:3105',inbox='http://127.0.0.1:54324';
const password=randomBytes(24).toString('base64url');
async function user(name,role){
 const email='phase5-'+run+'-'+name+'@cyclo.test';
 const r=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.equal(r.error,null);
 const id=r.data.user.id,client=createClient(url,key,options);people[name]={id,email,client};
 const update=await admin.from('profiles').update({role,full_name:'Phase5 '+name}).eq('id',id);assert.equal(update.error,null);
 const login=await client.auth.signInWithPassword({email,password});assert.equal(login.error,null);
}
async function reserve(name,role='DEVELOPER'){
 const email='phase5-'+run+'-'+name+'@cyclo.test';
 const result=await people.sa.client.rpc('admin_create_employee_invitation',{p_email:email,p_full_name:'Invited '+name,p_role:role});assert.equal(result.error,null);
 const invitation=result.data[0];invites.push(invitation);
 const sent=await admin.auth.admin.inviteUserByEmail(email,{redirectTo:app+'/auth/confirm'});assert.equal(sent.error,null);
 people[name]={id:sent.data.user.id,email,client:createClient(url,key,options)};
 return invitation;
}
async function emailLink(email){
 for(let i=0;i<40;i++){
  const list=await(await fetch(inbox+'/api/v1/messages')).json();
  const message=list.messages.find(m=>m.To?.some(t=>t.Address===email));
  if(message){mailIds.add(message.ID);const detail=await(await fetch(inbox+'/api/v1/message/'+message.ID)).json();const html=detail.HTML??detail.Text;const link=html.match(/href="([^"]+token_hash[^"]+)"/i)?.[1];assert.ok(link,'Supabase invitation template contains callback link');return link.replaceAll('&amp;','&');}
  await new Promise(r=>setTimeout(r,50));
 }
 throw Error('Local invitation email not captured');
}
function cookieHeader(response){return response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
before(async()=>{
 const existing=await admin.from('profiles').select('id').eq('role','SUPER_ADMIN').eq('is_active',true);assert.ok(existing.data.length);
 await user('sa','SUPER_ADMIN');await user('pm','PROJECT_MANAGER');await user('dev','DEVELOPER');
});
after(async()=>{
 // Only this suite's UUIDs. Never delete production audit data through API roles.
 const ids=Object.values(people).map(p=>p.id);assert.ok(ids.every(id=>/^[0-9a-f-]{36}$/i.test(id)));
 for(const person of [...Object.values(people)].sort((a,b)=>Number(a.id===people.sa.id)-Number(b.id===people.sa.id))){
  const row=await admin.from('profiles').select('role,is_active').eq('id',person.id).single();
  if(row.data?.role==='SUPER_ADMIN'&&row.data.is_active)assert.equal((await admin.from('profiles').update({role:'DEVELOPER'}).eq('id',person.id)).error,null);
  assert.equal((await admin.auth.admin.deleteUser(person.id)).error,null);
 }
 if(ids.length){const cleanup=localSql(`delete from private.employee_audit_log where actor_id in (${ids.map(id=>"'"+id+"'").join(',')}); delete from private.employee_invitations where inviter_id='${people.sa.id}';`);assert.equal(cleanup.code,0,cleanup.stderr);}
 const list=await(await fetch(inbox+'/api/v1/messages')).json();
 for(const message of list.messages)if(message.To?.some(t=>t.Address?.startsWith('phase5-'+run+'-')))mailIds.add(message.ID);
 if(mailIds.size)assert.ok((await fetch(inbox+'/api/v1/messages',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({IDs:[...mailIds]})})).ok);
});
test('PM and Developer cannot create, list or manage invitations',async()=>{
 for(const person of [people.pm,people.dev]){
  for(const [name,args]of [['admin_create_employee_invitation',{p_email:'no@cyclo.test',p_full_name:'No',p_role:'SUPER_ADMIN'}],['admin_list_employee_invitations',{}],['admin_revoke_employee_invitation',{p_invitation_id:randomUUID()}]])assert.equal((await person.client.rpc(name,args)).error?.code,'42501');
 }
});
test('duplicate invitation and existing employee are rejected',async()=>{
 const first=await reserve('primary','SUPER_ADMIN');
 assert.equal((await people.sa.client.rpc('admin_create_employee_invitation',{p_email:first.email,p_full_name:'Other',p_role:'DEVELOPER'})).error?.code,'23505');
 assert.equal((await people.sa.client.rpc('admin_create_employee_invitation',{p_email:people.dev.email,p_full_name:'Existing',p_role:'DEVELOPER'})).error?.message,'employee_exists');
});
test('Mailpit captures local callback; trigger preserves selected role and blocks activation',async()=>{
 const link=await emailLink(people.primary.email);const parsed=new URL(link);assert.equal(parsed.origin,app);assert.equal(parsed.pathname,'/auth/confirm');assert.equal(parsed.searchParams.get('type'),'invite');
 const row=await admin.from('profiles').select('role,is_active,invited_by').eq('id',people.primary.id).single();assert.equal(row.data.role,'SUPER_ADMIN');assert.equal(row.data.is_active,false);assert.equal(row.data.invited_by,people.sa.id);
 assert.equal((await people.sa.client.rpc('admin_set_employee_active',{p_employee_id:people.primary.id,p_is_active:true})).error?.code,'23514');
 assert.equal((await people.sa.client.rpc('admin_set_employee_role',{p_employee_id:people.primary.id,p_role:'DEVELOPER'})).error?.code,'23514');
});
test('real callback accepts once; application blocks dashboard until atomic completion',async()=>{
 const link=await emailLink(people.primary.email);
 const response=await fetch(link,{redirect:'manual'});assert.equal(response.status,303);assert.equal(new URL(response.headers.get('location'),app).pathname,'/onboarding');
 let cookie=cookieHeader(response);assert.ok(cookie);
 const page=await fetch(app+'/onboarding',{headers:{cookie},redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/Set a password|New password/);
 const blocked=await fetch(app+'/dashboard',{headers:{cookie},redirect:'manual'});assert.equal(blocked.status,303);assert.equal(new URL(blocked.headers.get('location'),app).pathname,'/login');
 const replay=await fetch(link,{redirect:'manual'});assert.match(replay.headers.get('location'),/invitation_invalid/);
 // Recover an accepted invitation after losing the browser session, without
 // changing its ACCEPTED state or replaying acceptance.
 const primaryInvite=invites.find(i=>i.email===people.primary.email);
 const retry=await people.sa.client.rpc('admin_resend_employee_invitation',{p_invitation_id:primaryInvite.id});assert.equal(retry.error,null);assert.equal(retry.data[0].status,'ACCEPTED');
 await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal((await admin.auth.signInWithOtp({email:people.primary.email,options:{shouldCreateUser:false,emailRedirectTo:app+'/auth/confirm'}})).error,null);
 const resumeLink=await emailLink(people.primary.email);
 const resume=await fetch(resumeLink,{redirect:'manual'});assert.equal(new URL(resume.headers.get('location'),app).pathname,'/onboarding');cookie=cookieHeader(resume);assert.ok(cookie);
 // Use the cookie-authenticated session via Auth user endpoints only; no Admin password setup.
 const cookieParts=cookie.split('; ').map(c=>c.slice(c.indexOf('=')+1));
 const sessionValue=decodeURIComponent(cookieParts.join(''));assert.ok(sessionValue.startsWith('base64-'));
 const session=JSON.parse(Buffer.from(sessionValue.slice(7),'base64url').toString('utf8'));
 const client=people.primary.client;assert.equal((await client.auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token})).error,null);
 assert.equal((await client.rpc('list_employees')).error?.code,'42501');
 assert.equal((await client.rpc('complete_employee_onboarding',{p_full_name:'Too early'})).error?.code,'22023');
 assert.equal((await client.auth.updateUser({password})).error,null);
 assert.equal((await client.rpc('start_employee_onboarding')).error,null);
 const results=await Promise.all([client.rpc('complete_employee_onboarding',{p_full_name:'Completed Invitee'}),client.rpc('complete_employee_onboarding',{p_full_name:'Replay'})]);assert.equal(results.filter(r=>!r.error).length,1);
 const profile=await admin.from('profiles').select('is_active,role,onboarded_at').eq('id',people.primary.id).single();assert.equal(profile.data.is_active,true);assert.equal(profile.data.role,'SUPER_ADMIN');assert.ok(profile.data.onboarded_at);
 assert.equal((await client.rpc('list_employees')).error,null);
 const allowed=await fetch(app+'/dashboard',{headers:{cookie},redirect:'manual'});assert.equal(allowed.status,200);
});
test('expired and revoked invitations cannot be accepted even after Auth verifies the email',async()=>{
 for(const mode of ['expired','revoked']){
  const invitation=await reserve(mode);const link=await emailLink(people[mode].email);
  if(mode==='revoked')assert.equal((await people.sa.client.rpc('admin_revoke_employee_invitation',{p_invitation_id:invitation.id})).error,null);
  else {const q=localSql(`update private.employee_invitations set expires_at=now()-interval '1 second' where id='${invitation.id}';`);assert.equal(q.code,0,q.stderr);}
  const result=await people[mode].client.auth.verifyOtp({token_hash:new URL(link).searchParams.get('token_hash'),type:'invite'});assert.equal(result.error,null);
  assert.equal((await people[mode].client.rpc('accept_employee_invitation')).error?.message,'invalid_invitation');
  assert.equal((await people[mode].client.rpc('list_employees')).error?.code,'42501');
 }
});
test('resend uses Supabase Auth again and retains invitation identity and role',async()=>{
 const invitation=invites.find(i=>i.email===people.expired.email);
 const prepared=await people.sa.client.rpc('admin_resend_employee_invitation',{p_invitation_id:invitation.id});assert.equal(prepared.error,null);assert.equal(prepared.data[0].assigned_role,invitation.assigned_role);
 await new Promise(resolve=>setTimeout(resolve,1100));
 const resumed=await admin.auth.signInWithOtp({email:people.expired.email,options:{shouldCreateUser:false,emailRedirectTo:app+'/auth/confirm'}});assert.equal(resumed.error,null);
 const resumeLink=await emailLink(people.expired.email);assert.equal(new URL(resumeLink).searchParams.get('type'),'email');
 const verified=await people.expired.client.auth.verifyOtp({token_hash:new URL(resumeLink).searchParams.get('token_hash'),type:'email'});assert.equal(verified.error,null);
 assert.equal((await people.expired.client.rpc('accept_employee_invitation')).error,null);
 // Still-unverified accounts use the invitation Admin endpoint on resend.
 const pending=await reserve('resend','PROJECT_MANAGER');
 assert.equal((await people.sa.client.rpc('admin_resend_employee_invitation',{p_invitation_id:pending.id})).error,null);
 const resent=await admin.auth.admin.inviteUserByEmail(people.resend.email,{redirectTo:app+'/auth/confirm'});assert.equal(resent.error,null);assert.equal(resent.data.user.id,people.resend.id);
});

test('invitation expiry is checked against wall clock after waiting for its lock',async()=>{
 const invitation=await reserve('expiry-race');const link=await emailLink(people['expiry-race'].email);
 assert.equal((await people['expiry-race'].client.auth.verifyOtp({token_hash:new URL(link).searchParams.get('token_hash'),type:'invite'})).error,null);
 const blocker=startLocalSql(`begin;select id from private.employee_invitations where id='${invitation.id}' for update;select 'LOCK_READY';\n`,{keepOpen:true});
 let mutation;
 try{
  await pollUntil(()=>blocker.output().includes('LOCK_READY'));
  const tag='invite-expiry-'+run;
  mutation=startLocalSql(`begin;set local application_name='${tag}';set local statement_timeout='5s';select set_config('request.jwt.claims','{"sub":"${people['expiry-race'].id}"}',true);set local role authenticated;select public.accept_employee_invitation();commit;`);
  await pollUntil(()=>localSql(`select count(*) from pg_stat_activity where application_name='${tag}' and wait_event_type='Lock';`).stdout.trim()==='1');
  await new Promise(resolve=>setTimeout(resolve,50));
  blocker.child.stdin.end(`update private.employee_invitations set expires_at=clock_timestamp()-interval '1 millisecond' where id='${invitation.id}';commit;\n\\q\n`);
  assert.equal((await blocker.completed).code,0);
  const result=await mutation.completed;assert.notEqual(result.code,0);assert.match(result.stderr,/42501.*invalid_invitation/);
 }finally{
  if(!blocker.child.stdin.writableEnded)blocker.child.stdin.end('rollback;\n\\q\n');
  await blocker.completed;if(mutation)await mutation.completed;
 }
});

test('Super Admin invite form executes the real Server Action and sends Auth email',async()=>{
 const cookies=new Map();
 const client=createServerClient(url,key,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>{for(const {name,value}of values)cookies.set(name,value);}}});
 assert.equal((await client.auth.signInWithPassword({email:people.sa.email,password})).error,null);
 const cookie=[...cookies].map(([name,value])=>name+'='+value).join('; ');
 const page=await fetch(app+'/employees/invitations',{headers:{cookie}});assert.equal(page.status,200);const html=await page.text();
 const form=[...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(m=>m[1]).find(text=>text.includes('name="fullName"')&&text.includes('name="email"'));assert.ok(form,'rendered invite form');
 const decode=value=>value.replaceAll('&quot;','"').replaceAll('&#x27;',"'").replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
 const data=new FormData();for(const input of form.matchAll(/<input\b[^>]*>/g)){
  const name=input[0].match(/name="([^"]+)"/)?.[1],value=input[0].match(/value="([^"]*)"/)?.[1];
  if(name?.startsWith('$ACTION_'))data.append(decode(name),decode(value??''));
 }
 const email='phase5-'+run+'-ui@cyclo.test';data.set('email',email);data.set('fullName','UI Invitee');data.set('role','PROJECT_MANAGER');
 const response=await fetch(app+'/employees/invitations',{method:'POST',headers:{cookie,Origin:app},body:data});assert.equal(response.status,200);const body=await response.text();
 const profile=await admin.from('profiles').select('id,role,is_active').eq('email',email).maybeSingle();
 if(profile.data)people.ui={id:profile.data.id,email,client:createClient(url,key,options)};
 assert.ok(profile.data,'Auth Admin API created the invited profile');assert.equal(profile.data.role,'PROJECT_MANAGER');assert.equal(profile.data.is_active,false);assert.match(body,/Invitation updated/);
 const link=await emailLink(email);assert.equal(new URL(link).origin,app);
});
