import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
const require=createRequire(import.meta.url);
const React=require("react");
const {renderToStaticMarkup}=require("react-dom/server");
const errors=loadTsModule("src/features/employees/errors.ts");
const validation=loadTsModule("src/features/employees/mutation-validation.ts",{"./errors":errors});
const ID="40000000-0000-4000-a000-000000000001", OTHER="40000000-0000-4000-a000-000000000002";
const row={id:OTHER,full_name:"New Name",avatar_url:null,email:"e@test.local",employee_code:null,role:"DEVELOPER",is_active:true,is_git_organizer:false,invited_by:null,invited_by_name:null,onboarded_at:null,created_at:"2026-11-21T00:00:00Z",updated_at:"2026-11-21T00:00:00Z",secret:"must not leak"};
function mutations({role="SUPER_ADMIN",rpc=async()=>({data:[row],error:null}),guard}={}) {
 const calls=[];
 const mod=loadTsModule("src/features/employees/mutations.server.ts",{"server-only":{},"./errors":errors,"./mutation-validation":validation,
 "@/features/auth/server":{requireActiveProfile:guard??(async()=>({profile:{id:ID,role}}))},
 "@/lib/supabase/server":{createClient:async()=>({rpc:async(name,args)=>{calls.push({name,args});return rpc(name,args);}})}});
 return {...mod,calls};
}
const ops=[['updateEmployeeDetails',{fullName:' Name ',avatarUrl:''}],['setEmployeeCode',' CODE '],['setEmployeeRole','PROJECT_MANAGER'],['setEmployeeActive',false],['setGitOrganizer',true]];
test("mutation validation trims and bounds explicit fields",()=>{
 // URL whitespace is now rejected; an actually empty URL still clears it.
 assert.equal(JSON.stringify(validation.validateEmployeeDetails(' Name ','')),JSON.stringify({fullName:'Name',avatarUrl:null}));
 assert.equal(validation.validateEmployeeCode('  '),null);
 assert.equal(validation.validateEmployeeCode(' Ab-c_1 '),'Ab-c_1');
 for(const name of ['', ' '.repeat(4),'x'.repeat(201),null,{}]) assert.throws(()=>validation.validateEmployeeDetails(name,''),{code:'invalid_input'});
 for(const url of ['javascript:alert(1)','http://x.test','https://','https://x.test/a b','https://x.test/'+ 'a'.repeat(2048)]) assert.throws(()=>validation.validateEmployeeDetails('Name',url),{code:'invalid_input'});
 assert.throws(()=>validation.validateEmployeeCode('x'.repeat(33)),{code:'invalid_input'});
 assert.throws(()=>validation.validateEmployeeRole('ROOT'),{code:'invalid_input'});
 assert.throws(()=>validation.validateEmployeeBoolean('false'),{code:'invalid_input'});
});
for(const role of ['PROJECT_MANAGER','DEVELOPER']) test(role+" denied every server mutation before RPC",async()=>{
 const m=mutations({role}); for(const [fn,value] of ops) await assert.rejects(m[fn](OTHER,value),{code:'forbidden'}); assert.equal(m.calls.length,0);
});
test("authentication redirect is preserved",async()=>{
 const redirect=new Error('NEXT_REDIRECT'); const m=mutations({guard:async()=>{throw redirect;}});
 await assert.rejects(m.setEmployeeCode(OTHER,'CODE'),e=>e===redirect); assert.equal(m.calls.length,0);
});
test("every mutation uses scoped RPC and returns a whitelisted DTO",async()=>{
 const m=mutations(); for(const [fn,value] of ops){const result=await m[fn](OTHER,value);assert.equal('secret' in result,false);assert.equal(result.id,OTHER);}
 assert.deepEqual(m.calls.map(c=>c.name),['admin_update_employee_details','admin_set_employee_code','admin_set_employee_role','admin_set_employee_active','admin_set_git_organizer']);
 assert.equal(JSON.stringify(m.calls[0].args),JSON.stringify({p_employee_id:OTHER,p_full_name:'Name',p_avatar_url:''}));
 assert.equal(m.calls[1].args.p_employee_code,'CODE');
 assert.ok(m.calls.every(c=>!('actor_id' in c.args)));
});
test("self-demotion and deactivation rejected before RPC",async()=>{
 const m=mutations();await assert.rejects(m.setEmployeeRole(ID,'DEVELOPER'),{code:'self_management'});await assert.rejects(m.setEmployeeActive(ID,false),{code:'self_management'});assert.equal(m.calls.length,0);
 await m.setEmployeeRole(ID,'SUPER_ADMIN');await m.setEmployeeActive(ID,true);
});
test("untrusted input cannot reach mutation RPC",async()=>{
 const m=mutations();await assert.rejects(m.setEmployeeCode('../bad','x'),{code:'invalid_input'});await assert.rejects(m.setEmployeeRole(OTHER,'ROOT'),{code:'invalid_input'});await assert.rejects(m.setEmployeeActive(OTHER,'false'),{code:'invalid_input'});assert.equal(m.calls.length,0);
});
for(const [db,code] of [[{code:'23505',message:'secret SQL'},'duplicate_code'],[{code:'42501',message:'forbidden'},'forbidden'],[{code:'22023',message:'self_demotion'},'self_management'],[{code:'23514',message:'Cannot deactivate, demote, or delete the last active Super Admin.'},'last_admin'],[{code:'P0002'},'not_found']]) test('safe mutation error '+code,async()=>{
 const m=mutations({rpc:async()=>({data:null,error:db})});await assert.rejects(m.setEmployeeCode(OTHER,'X'),e=>e.code===code&&!e.message.includes('secret SQL'));
});
test("network and malformed RPC results fail safely",async()=>{
 await assert.rejects(mutations({rpc:async()=>{throw Error('secret network');}}).setEmployeeCode(OTHER,'X'),{code:'unavailable'});
 await assert.rejects(mutations({rpc:async()=>({data:[],error:null})}).setEmployeeCode(OTHER,'X'),{code:'not_found'});
 await assert.rejects(mutations({rpc:async()=>({data:[{}],error:null})}).setEmployeeCode(OTHER,'X'),{code:'unexpected'});
});
function actions(overrides={}) {
 const calls=[],paths=[]; const mocks={};
 for(const [name] of ops)mocks[name]=async(...args)=>{calls.push({name,args});return row;};
 const mod=loadTsModule('src/features/employees/actions.ts',{'./errors':errors,'./mutations.server':{...mocks,...overrides},'next/cache':{revalidatePath:path=>paths.push(path)}});
 return {...mod,calls,paths};
}
const initial={error:null,success:null};
test("actions whitelist fields and revalidate list and detail",async()=>{
 const a=actions();const form=new FormData();form.set('fullName','Name');form.set('avatarUrl','');form.set('email','attacker@test.local');form.set('actor_id',OTHER);
 const result=await a.updateEmployeeDetailsAction(OTHER,initial,form);
 assert.equal(result.error,null);assert.equal(a.calls[0].args.length,2);assert.equal(JSON.stringify(a.calls[0].args[1]),JSON.stringify({fullName:'Name',avatarUrl:''}));assert.deepEqual(a.paths,['/employees','/employees/'+OTHER]);
});
test("action validation and database failure show safe errors without revalidation",async()=>{
 const a=actions({setEmployeeCode:async()=>{throw new errors.EmployeeError('duplicate_code');}});
 const form=new FormData();form.set('employeeCode','X');const result=await a.setEmployeeCodeAction(OTHER,initial,form);assert.match(result.error,/already assigned/);assert.equal(result.success,null);assert.equal(a.paths.length,0);
 for(const value of ['yes','', '0']){form.set('isActive',value);assert.match((await a.setEmployeeActiveAction(OTHER,initial,form)).error,/invalid values/);}
 assert.match((await a.updateEmployeeDetailsAction(OTHER,initial,new FormData())).error,/invalid values/);
});
test("all other actions call their scoped mutation and preserve redirects",async()=>{
 const a=actions();const form=new FormData();form.set('employeeCode','C');form.set('role','DEVELOPER');form.set('isActive','false');form.set('isGitOrganizer','true');
 for(const name of ['setEmployeeCodeAction','setEmployeeRoleAction','setEmployeeActiveAction','setGitOrganizerAction'])assert.equal((await a[name](OTHER,initial,form)).error,null);
 assert.equal(a.calls[2].args[1],false);assert.equal(a.calls[3].args[1],true);
 const redirect=Error('NEXT_REDIRECT');await assert.rejects(actions({setEmployeeCode:async()=>{throw redirect;}}).setEmployeeCodeAction(OTHER,initial,form),e=>e===redirect);
});
const actionMocks=Object.fromEntries(['updateEmployeeDetailsAction','setEmployeeCodeAction','setEmployeeRoleAction','setEmployeeActiveAction','setGitOrganizerAction'].map(k=>[k,async()=>initial]));
const employee={id:OTHER,fullName:'Name',avatarUrl:null,employeeCode:'C',role:'DEVELOPER',isActive:true,isGitOrganizer:false};
test("admin forms render accessible controls and self restrictions",()=>{
 const ui=loadTsModule('src/features/employees/components/employee-management.tsx',{'../actions':actionMocks});
 const html=renderToStaticMarkup(React.createElement(ui.EmployeeManagement,{employee,isSelf:false}));
 assert.match(html,/name="fullName"/);assert.match(html,/name="employeeCode"/);assert.match(html,/<dialog/);assert.match(html,/aria-live="polite"/);assert.doesNotMatch(html,/name="email"/);
 const self=renderToStaticMarkup(React.createElement(ui.EmployeeManagement,{employee:{...employee,role:'SUPER_ADMIN'},isSelf:true}));
 assert.match(self,/cannot change your own role/);assert.equal((self.match(/<fieldset disabled=""/g)||[]).length,2);
});
function formHarness({pending=false,state=initial,confirmation,disabled=false}={}) {
 const refs=[]; let n=0;
 const ui=loadTsModule('src/features/employees/components/employee-management.tsx',{'../actions':actionMocks,react:{...React,useActionState:()=>[state,()=>{},pending],useRef:()=>{const r={current:null};refs.push(r);return r;},useId:()=>String(++n),useEffect:fn=>fn()}});
 const tree=ui.ManagementForm({title:'Change role',action:async()=>initial,children:null,confirmation,disabled});
 const children=tree.props.children;return {tree,form:children[1],dialog:children[2],refs};
}
test("pending forms disable submission and show feedback",()=>{
 const h=formHarness({pending:true,state:{error:'Safe error',success:null}});
 const html=renderToStaticMarkup(h.tree);assert.match(html,/Saving…/);assert.match(html,/fieldset disabled/);assert.match(html,/Safe error/);assert.match(html,/aria-busy="true"/);
 let prevented=false;h.form.props.onSubmit({preventDefault(){prevented=true;}});assert.equal(prevented,true);
 assert.match(renderToStaticMarkup(formHarness({state:{error:null,success:'Employee saved.'}}).tree),/Employee saved/);
});
test("confirmation precedes submit and repeated submission is prevented",()=>{
 const h=formHarness({confirmation:'Continue?'});let shown=0,closed=0,submitted=0,prevented=0;
 h.refs[1].current={showModal(){shown++;},close(){closed++;}};
 const event={preventDefault(){prevented++;}};
 h.refs[0].current={requestSubmit(){h.form.props.onSubmit(event);submitted++;}};
 h.form.props.onSubmit(event);assert.equal(shown,1);assert.equal(prevented,1);assert.equal(submitted,0);
 const buttons=h.dialog.props.children[2].props.children;
 buttons[0].props.onClick();assert.equal(closed,1);assert.equal(submitted,0);
 h.form.props.onSubmit(event);buttons[1].props.onClick();assert.equal(submitted,1);
 h.form.props.onSubmit(event);assert.equal(submitted,1);assert.equal(shown,2);assert.equal(prevented,3);
});

for (const role of ['SUPER_ADMIN','PROJECT_MANAGER','DEVELOPER']) test('detail page mutation visibility for '+role,async()=>{
 const dto={...employee,email:'test@cyclo.test'};
 const notFound=()=>{throw Object.assign(Error('not found'),{code:'NOT_FOUND'});};
 const page=loadTsModule('src/app/(dashboard)/employees/[id]/page.tsx',{
  'next/link':{__esModule:true,default:({children})=>React.createElement('a',null,children)},
  'next/navigation':{notFound},
  '@/features/auth/server':{requireActiveProfile:async()=>({profile:{id:ID,role}})},
  '@/features/employees/page-errors.server':{loadForPage:async(fn)=>({data:await fn(),error:null})},
  '@/features/employees/queries.server':{adminGetEmployee:async()=>{assert.equal(role,'SUPER_ADMIN');return dto;},getEmployee:async()=>{assert.equal(role,'PROJECT_MANAGER');return dto;}},
  '@/features/employees/components/employee-management':{EmployeeManagement:()=>React.createElement('div',null,'MUTATION_CONTROLS')},
  '@/features/employees/components/employee-details':{EmployeeHeader:()=>null,EmployeeDirectoryFields:()=>null,EmployeeAdminFields:()=>React.createElement('div',null,'ADMIN_FIELDS')},
 });
 if(role==='DEVELOPER'){await assert.rejects(page.default({params:Promise.resolve({id:OTHER})}),{code:'NOT_FOUND'});return;}
 const html=renderToStaticMarkup(await page.default({params:Promise.resolve({id:OTHER})}));
 assert.equal(html.includes('MUTATION_CONTROLS'),role==='SUPER_ADMIN');assert.equal(html.includes('ADMIN_FIELDS'),role==='SUPER_ADMIN');
});
