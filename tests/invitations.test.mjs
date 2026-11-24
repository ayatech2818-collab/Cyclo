import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {loadTsModule} from './helpers/load-ts-module.mjs';
const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const validation=loadTsModule('src/features/invitations/validation.ts');
const errors=loadTsModule('src/features/invitations/errors.ts');
const ID='60000000-0000-4000-a000-000000000001';
const row={id:ID,email:'invite@test.example',full_name:'Invited',assigned_role:'PROJECT_MANAGER',auth_user_id:null,status:'PENDING',created_at:'2026-11-21T00:00:00Z',expires_at:'2026-11-21T01:00:00Z',last_sent_at:null,delivery_failed:false,secret:'must not leak'};
test('invitation validation normalizes email and name and allowlists role',()=>{
 const value=validation.validateInvitation({email:' Person@Test.Example ',fullName:' Name ',role:'SUPER_ADMIN'});assert.equal(value.email,'person@test.example');assert.equal(value.fullName,'Name');assert.equal(value.role,'SUPER_ADMIN');
 for(const input of [{email:'bad',fullName:'Name',role:'DEVELOPER'},{email:'a@test.example',fullName:' ',role:'DEVELOPER'},{email:'a@test.example',fullName:'Name',role:'OWNER'},{email:null,fullName:'Name',role:'DEVELOPER'}])assert.throws(()=>validation.validateInvitation(input));
});
test('onboarding password validates confirmation and UTF8 byte limit without trimming',()=>{
 assert.equal(validation.validateOnboardingPassword('  password123456  ','  password123456  '),'  password123456  ');
 for(const [a,b]of [['short','short'],['long-enough-password','different'],['🙂'.repeat(20),'🙂'.repeat(20)],[null,null]])assert.throws(()=>validation.validateOnboardingPassword(a,b));
});
function operations({role='SUPER_ADMIN',confirmed=false,sendError=null,rpcError=null}={}){
 const calls=[],sent=[];const api={admin:{inviteUserByEmail:async(...args)=>{sent.push(['invite',...args]);return {error:sendError};},getUserById:async()=>({data:{user:{email:row.email,email_confirmed_at:confirmed?'now':null}},error:null})},signInWithOtp:async(...args)=>{sent.push(['resume',...args]);return {error:null};}};
 const mod=loadTsModule('src/features/invitations/operations.server.ts',{'server-only':{},'./errors':errors,
 '@/features/auth/server':{requireActiveProfile:async()=>({profile:{id:ID,role,is_active:true}})},
 '@/lib/supabase/server':{createClient:async()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:[{...row,auth_user_id:confirmed?ID:null}],error:rpcError};}})},
 '@/lib/supabase/admin.server':{createAuthAdminClient:()=>({auth:api}),invitationCallbackUrl:()=> 'http://127.0.0.1:3105/auth/confirm'}});
 return {...mod,calls,sent};
}
for(const role of ['DEVELOPER','PROJECT_MANAGER'])test(role+' rejected before Auth Admin or invitation RPC',async()=>{
 const m=operations({role});await assert.rejects(m.inviteEmployee({email:row.email,fullName:'Name',role:'SUPER_ADMIN'}));await assert.rejects(m.listInvitations());await assert.rejects(m.resendInvitation(ID));await assert.rejects(m.revokeInvitation(ID));assert.equal(m.calls.length,0);assert.equal(m.sent.length,0);
});
test('admin invitation reserves trusted fields before sending and records delivery',async()=>{
 const m=operations();await m.inviteEmployee({email:' Invite@Test.Example ',fullName:' Name ',role:'PROJECT_MANAGER',actor_id:'spoof'});
 assert.deepEqual(m.calls.map(c=>c.name),['admin_create_employee_invitation','admin_record_invitation_delivery']);assert.equal(m.calls[0].args.p_email,row.email);assert.equal('actor_id' in m.calls[0].args,false);assert.equal(m.sent[0][0],'invite');assert.equal(m.calls[1].args.p_success,true);
});
test('verified invitees get an Auth-generated resume email; no manual link sending',async()=>{
 const m=operations({confirmed:true});await m.resendInvitation(ID);assert.equal(m.sent[0][0],'resume');assert.equal(m.sent[0][1].options.shouldCreateUser,false);
});
test('delivery failure preserves invitation and surfaces a safe retry message',async()=>{
 const m=operations({sendError:{message:'secret token details'}});await assert.rejects(m.inviteEmployee({email:row.email,fullName:'Name',role:'DEVELOPER'}),e=>/delivery failed/.test(e.message)&&!e.message.includes('secret'));assert.equal(m.calls.at(-1).args.p_success,false);
});
test('safe DTO and duplicate errors do not leak raw rows or errors',async()=>{
 const m=operations();const list=await m.listInvitations();assert.equal('secret' in list[0],false);assert.equal(list[0].role,'PROJECT_MANAGER');
 await assert.rejects(operations({rpcError:{code:'23505',message:'employee_exists'}}).inviteEmployee({email:row.email,fullName:'Name',role:'DEVELOPER'}),/already uses/);
 assert.doesNotMatch(errors.invitationFailure({code:'XX000',message:'raw postgres secret'}).message,/raw postgres secret/);
});
const nextLink={__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)};
test('invitation page denies PM and Developer before fetching invitation records',async()=>{
 for(const role of ['PROJECT_MANAGER','DEVELOPER']){
  const page=loadTsModule('src/app/(dashboard)/employees/invitations/page.tsx',{'next/link':nextLink,'next/navigation':{notFound(){throw Error('NOT_FOUND');}},'@/features/auth/server':{requireActiveProfile:async()=>({profile:{role}})},'@/features/invitations/forms':{},'@/features/invitations/operations.server':{listInvitations(){assert.fail('must not fetch invitations');}}});
  await assert.rejects(page.default(),/NOT_FOUND/);
 }
});
test('callback validates token type, establishes session then accepts invitation',async()=>{
 const calls=[];const server={createClient:async()=>({auth:{verifyOtp:async(args)=>{calls.push(['verify',args]);return {error:null};},signOut:async()=>{calls.push(['signout']);return {error:null};}},rpc:async(name)=>{calls.push([name]);return {error:null,data:[{status:'PENDING'}]};}})};
 const route=loadTsModule('src/app/auth/confirm/route.ts',{'@/lib/supabase/server':server});
 const url=new URL('http://127.0.0.1:3105/auth/confirm?token_hash='+ 'a'.repeat(64)+'&type=invite&next=https://evil.test');
 const response=await route.GET({nextUrl:url,url:url.href});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/onboarding');assert.deepEqual(calls.map(c=>c[0]),['verify','get_my_employee_invitation','accept_employee_invitation']);assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('cache-control'),'private, no-store');
 calls.length=0;url.searchParams.set('type','recovery');const denied=await route.GET({nextUrl:url,url:url.href});assert.equal(denied.headers.get('location'),'/login?error=invitation_invalid');assert.equal(calls.length,0);
});
test('callback redirect stays on the browser host even when request.url names another host',async()=>{
 // next dev reports request.url as "localhost" for a 127.0.0.1 request; the
 // session cookie is scoped to 127.0.0.1, so an absolute localhost redirect would drop it.
 const server={createClient:async()=>({auth:{verifyOtp:async()=>({error:null}),signOut:async()=>assert.fail('must keep session')},rpc:async(name)=>({error:null,data:name==='get_my_employee_invitation'?[{status:'PENDING'}]:[]})})};
 const route=loadTsModule('src/app/auth/confirm/route.ts',{'@/lib/supabase/server':server});
 const query='?token_hash='+'a'.repeat(64)+'&type=invite';
 const response=await route.GET({nextUrl:new URL('http://127.0.0.1:3000/auth/confirm'+query),url:'http://localhost:3000/auth/confirm'+query});
 const location=response.headers.get('location');assert.equal(location,'/onboarding');assert.doesNotMatch(location,/localhost|127\.0\.0\.1|:\/\//);
});
test('callback signs out an Auth session when invitation acceptance fails',async()=>{
 let signedOut=false;const route=loadTsModule('src/app/auth/confirm/route.ts',{'@/lib/supabase/server':{createClient:async()=>({auth:{verifyOtp:async()=>({error:null}),signOut:async()=>{signedOut=true;return {error:null};}},rpc:async()=>({error:{message:'invalid_invitation'}})})}});
 const url=new URL('http://127.0.0.1:3105/auth/confirm?token_hash='+ 'a'.repeat(64)+'&type=invite');await route.GET({nextUrl:url,url:url.href});assert.equal(signedOut,true);
});
test('onboarding forms expose only password or full-name fields with pending protection',()=>{
 const action=async()=>({error:null,success:null});const forms=loadTsModule('src/features/invitations/forms.tsx',{'./actions':{inviteEmployeeAction:action,resendInvitationAction:action,revokeInvitationAction:action},'./onboarding-actions':{setOnboardingPassword:action,completeOnboarding:action},'@/features/employees/components/employee-management':{ManagementForm:()=>null}});
 for(const step of ['password','profile']){
  const html=renderToStaticMarkup(React.createElement(forms.OnboardingForm,{step,fullName:'Name'}));assert.doesNotMatch(html,/name="role"|name="isActive"|name="employeeCode"|name="invitedBy"/);assert.match(html,/aria-live="polite"/);assert.match(html,step==='password'?/name="password"/:/name="fullName"/);
 }
});

function onboardingActions(status='ACCEPTED') {
 const calls=[];
 const mod=loadTsModule('src/features/invitations/onboarding-actions.ts',{'./errors':errors,'./onboarding.server':{requireOnboarding:async()=>({invitation:{status},client:{auth:{updateUser:async(args)=>{calls.push(['password',args]);return {error:null};}}}})},'./operations.server':{invitationRpc:async(...args)=>{calls.push(args);return [];}},'next/cache':{revalidatePath(){}},'next/navigation':{redirect(path){throw Object.assign(Error('redirect'),{path});}}});
 return {...mod,calls};
}
test('password action updates Auth before starting onboarding and never sends password to RPC',async()=>{
 const a=onboardingActions();const data=new FormData();data.set('password','valid-password-123');data.set('confirmation','valid-password-123');
 await assert.rejects(a.setOnboardingPassword({error:null,success:null},data),{path:'/onboarding/complete'});
 assert.equal(a.calls[0][0],'password');assert.equal(a.calls[1][0],'start_employee_onboarding');assert.equal(JSON.stringify(a.calls[1][1]),'{}');
 const expired=onboardingActions('EXPIRED');assert.match((await expired.setOnboardingPassword({error:null,success:null},data)).error,/valid invitation/);assert.equal(expired.calls.length,0);
});
test('profile completion action allowlists full name and ignores role/status spoofing',async()=>{
 const a=onboardingActions('ONBOARDING');const data=new FormData();data.set('fullName',' Name ');data.set('role','SUPER_ADMIN');data.set('is_active','true');data.set('inviter_id',ID);
 await assert.rejects(a.completeOnboarding({error:null,success:null},data),{path:'/dashboard'});
 assert.equal(a.calls[0][0],'complete_employee_onboarding');assert.equal(JSON.stringify(a.calls[0][1]),JSON.stringify({p_full_name:'Name'}));
});
function authActions(status='authorized',invitationStatus=null) {
 let signedOut=false;
 const client={auth:{signInWithPassword:async()=>({error:null}),signOut:async()=>{signedOut=true;return {error:null};}},rpc:async()=>({error:null,data:invitationStatus?[{status:invitationStatus}]:[]})};
 const mod=loadTsModule('src/features/auth/actions.ts',{'@/features/auth/access':{getAccess:async()=>({status,profile:{full_name:null,role:'SUPER_ADMIN'}})},'@/features/auth/validation':{validateCredentials:()=>({email:'legacy@test.example',password:'test-only'})},'@/lib/supabase/server':{createClient:async()=>client},'next/cache':{revalidatePath(){}},'next/navigation':{redirect(path){throw Object.assign(Error('redirect'),{path});}}});
 return {...mod,signedOut:()=>signedOut};
}
test('existing active admin with NULL full name/onboarding remains on ordinary login flow',async()=>{
 const a=authActions();await assert.rejects(a.login({error:null},new FormData()),{path:'/dashboard'});assert.equal(a.signedOut(),false);
});
test('login resumes own onboarding but rejects inactive accounts without a valid invitation',async()=>{
 for(const [status,path]of [['ACCEPTED','/onboarding'],['ONBOARDING','/onboarding/complete']])await assert.rejects(authActions('denied',status).login({error:null},new FormData()),{path});
 for(const status of [null,'EXPIRED','REVOKED']){const a=authActions('denied',status);assert.match((await a.login({error:null},new FormData())).error,/active CYCLO access/);assert.equal(a.signedOut(),true);}
});
test('logout still clears local sessions and redirects inactive users',async()=>{
 const a=authActions('denied');await assert.rejects(a.logout(),{path:'/login'});assert.equal(a.signedOut(),true);
});

test('verified resume links continue onboarding without replaying acceptance',async()=>{
 const calls=[];const route=loadTsModule('src/app/auth/confirm/route.ts',{'@/lib/supabase/server':{createClient:async()=>({auth:{verifyOtp:async()=>({error:null}),signOut:async()=>assert.fail('must retain valid resume session')},rpc:async(name)=>{calls.push(name);return {error:null,data:[{status:'ONBOARDING'}]};}})}});
 const url=new URL('http://127.0.0.1:3105/auth/confirm?token_hash='+ 'a'.repeat(64)+'&type=email');const response=await route.GET({nextUrl:url,url:url.href});assert.match(response.headers.get('location'),/onboarding\/complete$/);assert.deepEqual(calls,['get_my_employee_invitation']);
});
