-- Phase 5: invitation authority, inactive invited profiles, atomic onboarding.
begin;
alter table public.profiles add column requires_onboarding boolean not null default false;
create table private.employee_invitations (
 id uuid primary key default gen_random_uuid(),
 email text not null check(email=lower(btrim(email)) and char_length(email)<=254 and email ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$'),
 full_name text not null check(char_length(btrim(full_name)) between 1 and 200),
 assigned_role public.app_role not null,
 inviter_id uuid not null,
 auth_user_id uuid unique,
 status text not null default 'PENDING' check(status in ('PENDING','ACCEPTED','ONBOARDING','COMPLETED','EXPIRED','REVOKED')),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now()+interval '1 hour'),
 accepted_at timestamptz,
 completed_at timestamptz,
 last_sent_at timestamptz,
 delivery_failed boolean not null default false
);
create unique index employee_invitations_active_email on private.employee_invitations(email)
 where status in ('PENDING','ACCEPTED','ONBOARDING');
alter table private.employee_invitations enable row level security;
revoke all on private.employee_invitations from public,anon,authenticated,service_role,cyclo_employee_api;
grant select,insert on private.employee_invitations to cyclo_employee_api;
grant update(auth_user_id,status,expires_at,accepted_at,completed_at,last_sent_at,delivery_failed) on private.employee_invitations to cyclo_employee_api;
create policy invitation_api_read on private.employee_invitations for select to cyclo_employee_api using(true);
create policy invitation_api_insert on private.employee_invitations for insert to cyclo_employee_api with check(true);
create policy invitation_api_update on private.employee_invitations for update to cyclo_employee_api using(true) with check(true);
grant update(requires_onboarding,onboarded_at) on public.profiles to cyclo_employee_api;

-- Extend the established append-only audit, without granting ordinary readers.
alter table private.employee_audit_log add column invitation_id uuid;
alter table private.employee_audit_log alter column target_employee_id drop not null;
alter table private.employee_audit_log drop constraint employee_audit_log_action_check;
alter table private.employee_audit_log add constraint employee_audit_log_action_check check(action in (
 'EMPLOYEE_PROFILE_UPDATED','EMPLOYEE_CODE_UPDATED','EMPLOYEE_ROLE_CHANGED','EMPLOYEE_ACTIVATED','EMPLOYEE_DEACTIVATED','GIT_ORGANIZER_GRANTED','GIT_ORGANIZER_REVOKED',
 'INVITATION_CREATED','INVITATION_RESENT','INVITATION_REVOKED','INVITATION_ACCEPTED','ONBOARDING_STARTED','ONBOARDING_COMPLETED'));
alter table private.employee_audit_log add constraint employee_audit_target_required check (
 (invitation_id is not null and action in ('INVITATION_CREATED','INVITATION_RESENT','INVITATION_REVOKED','INVITATION_ACCEPTED','ONBOARDING_STARTED','ONBOARDING_COMPLETED')) or
 (target_employee_id is not null and action in ('EMPLOYEE_PROFILE_UPDATED','EMPLOYEE_CODE_UPDATED','EMPLOYEE_ROLE_CHANGED','EMPLOYEE_ACTIVATED','EMPLOYEE_DEACTIVATED','GIT_ORGANIZER_GRANTED','GIT_ORGANIZER_REVOKED')));
grant insert(invitation_id) on private.employee_audit_log to cyclo_employee_api;

-- This trusted Auth bridge reveals only identity/confirmation/password presence.
create function private.invitation_identity()
returns table(user_id uuid,email text,password_set boolean)
language sql stable security definer set search_path='' as $$
 select u.id,lower(u.email),coalesce(u.encrypted_password<>'',false)
 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null
$$;
revoke all on function private.invitation_identity() from public,anon,authenticated,service_role;
grant execute on function private.invitation_identity() to cyclo_employee_api;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare v_inv private.employee_invitations%rowtype;
begin
 select i.* into v_inv from private.employee_invitations i
  where i.email=lower(new.email) and i.status='PENDING' and i.expires_at>now() for update;
 if found then
  if v_inv.auth_user_id is not null then
   raise exception using errcode='42501',message='invalid_invitation';
  end if;
  insert into public.profiles(id,email,full_name,role,is_active,is_git_organizer,invited_by,requires_onboarding)
   values(new.id,new.email,v_inv.full_name,v_inv.assigned_role,false,false,v_inv.inviter_id,true);
  update private.employee_invitations set auth_user_id=new.id where id=v_inv.id;
 elsif new.invited_at is not null then
  raise exception using errcode='42501',message='invalid_invitation';
 else
  -- Existing non-invitation provisioning and all grandfathered profiles stay unchanged.
  insert into public.profiles(id,email,role,is_active,is_git_organizer)
   values(new.id,new.email,'DEVELOPER',true,false) on conflict(id) do nothing;
 end if;
 return new;
end;
$$;

-- Active status alone cannot bypass onboarding, even through Phase 4 RPCs.
create function private.protect_invitation_profile()
returns trigger language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare v_inv private.employee_invitations%rowtype;
begin
 if old.requires_onboarding then
  select i.* into v_inv from private.employee_invitations i where i.auth_user_id=old.id;
  if not found or new.role<>v_inv.assigned_role or new.invited_by is distinct from v_inv.inviter_id
     or new.is_git_organizer then
   raise exception using errcode='23514',message='invitation_profile_protected';
  end if;
  if new.requires_onboarding then
   if new.is_active or new.onboarded_at is not null then
    raise exception using errcode='23514',message='onboarding_required';
   end if;
  elsif v_inv.status<>'COMPLETED' or new.onboarded_at is null or not new.is_active then
   raise exception using errcode='23514',message='onboarding_required';
  end if;
 elsif new.requires_onboarding then
  raise exception using errcode='23514',message='invalid_onboarding_transition';
 end if;
 return new;
end;
$$;
revoke all on function private.protect_invitation_profile() from public,anon,authenticated,service_role;
create trigger profiles_protect_invitation before update on public.profiles for each row execute function private.protect_invitation_profile();

create function private.invitation_immutable_fields()
returns trigger language plpgsql set search_path='' as $$
begin
 if (new.email,new.full_name,new.assigned_role,new.inviter_id,new.created_at) is distinct from
    (old.email,old.full_name,old.assigned_role,old.inviter_id,old.created_at) then
  raise exception using errcode='23514',message='invitation_fields_immutable';
 end if;
 return new;
end;
$$;
revoke all on function private.invitation_immutable_fields() from public,anon,authenticated,service_role;
create trigger invitations_immutable before update on private.employee_invitations for each row execute function private.invitation_immutable_fields();

create function private.admin_create_employee_invitation(p_email text,p_full_name text,p_role public.app_role) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid; v_id uuid; v_email text:=lower(btrim(p_email)); v_name text:=btrim(p_full_name); v_status text:='PENDING';
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 if p_role is null or p_email is null or p_full_name is null then raise exception using errcode='22023',message='invalid_invitation_input'; end if;
 if v_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$' or char_length(v_email)>254 or char_length(v_name) not between 1 and 200 then raise exception using errcode='22023',message='invalid_invitation_input'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_email,5));
 if exists(select 1 from public.profiles p where lower(p.email)=v_email) then raise exception using errcode='23505',message='employee_exists'; end if;
 update private.employee_invitations set status='EXPIRED' where email=v_email and status in ('PENDING','ACCEPTED','ONBOARDING') and expires_at<=now();
 if exists(select 1 from private.employee_invitations i where i.email=v_email and i.status in ('PENDING','ACCEPTED','ONBOARDING')) then raise exception using errcode='23505',message='invitation_exists'; end if;
 insert into private.employee_invitations(email,full_name,assigned_role,inviter_id) values(v_email,v_name,p_role,v_actor) returning id into v_id;
 insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,null,v_id,'INVITATION_CREATED','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=v_id;
end;
$$;

create function private.admin_list_employee_invitations() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,case when i.status in ('PENDING','ACCEPTED','ONBOARDING') and i.expires_at<=now() then 'EXPIRED' else i.status end,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i order by i.created_at desc,i.id limit 200;
end;
$$;

create function private.admin_resend_employee_invitation(p_invitation_id uuid) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;v_inv private.employee_invitations%rowtype;v_status text:='PENDING';
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 select i.* into v_inv from private.employee_invitations i where i.id=p_invitation_id for update;
 if not found then raise exception using errcode='P0002',message='invitation_not_found'; end if;
 if v_inv.status not in ('PENDING','EXPIRED') then raise exception using errcode='22023',message='invalid_invitation_state'; end if;
 if v_inv.last_sent_at>now()-interval '60 seconds' then raise exception using errcode='22023',message='resend_too_soon'; end if;
 update private.employee_invitations set status='PENDING',expires_at=now()+interval '1 hour',delivery_failed=false where id=p_invitation_id;
 insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,null,p_invitation_id,'INVITATION_RESENT','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=p_invitation_id;
end;
$$;

create function private.admin_revoke_employee_invitation(p_invitation_id uuid) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;v_inv private.employee_invitations%rowtype;v_status text:='REVOKED';
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 select i.* into v_inv from private.employee_invitations i where i.id=p_invitation_id for update;
 if not found then raise exception using errcode='P0002',message='invitation_not_found'; end if;
 if v_inv.status in ('COMPLETED','REVOKED') then raise exception using errcode='22023',message='invalid_invitation_state'; end if;
 update private.employee_invitations set status='REVOKED' where id=p_invitation_id;
 insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,null,p_invitation_id,'INVITATION_REVOKED','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=p_invitation_id;
end;
$$;

create function private.admin_record_invitation_delivery(p_invitation_id uuid,p_success boolean) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 if p_success is null then raise exception using errcode='22023',message='invalid_delivery'; end if;
 update private.employee_invitations set last_sent_at=case when p_success then now() else last_sent_at end,delivery_failed=not p_success where id=p_invitation_id;
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,case when i.status in ('PENDING','ACCEPTED','ONBOARDING') and i.expires_at<=now() then 'EXPIRED' else i.status end,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=p_invitation_id;
end;
$$;

create function private.lock_my_invitation() returns uuid language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;v_email text;v_password boolean;v_inv private.employee_invitations%rowtype;
begin
select a.user_id,a.email,a.password_set into v_actor,v_email,v_password from private.invitation_identity() a;
 if v_actor is null then raise exception using errcode='42501',message='forbidden'; end if;
 select i.* into v_inv from private.employee_invitations i where i.auth_user_id=v_actor and i.email=v_email for update;
 if not found or v_inv.status in ('REVOKED','EXPIRED','COMPLETED') or v_inv.expires_at<=now() then raise exception using errcode='42501',message='invalid_invitation'; end if;
 return v_inv.id;
end;
$$;

create function private.get_my_employee_invitation() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_unused boolean;
begin
return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,case when i.status in ('PENDING','ACCEPTED','ONBOARDING') and i.expires_at<=now() then 'EXPIRED' else i.status end,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i join private.invitation_identity() a on a.user_id=i.auth_user_id and a.email=i.email;
end;
$$;

create function private.accept_employee_invitation() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_id uuid;v_actor uuid;v_status text;
begin
v_id:=private.lock_my_invitation();
 select i.status,i.auth_user_id into v_status,v_actor from private.employee_invitations i where i.id=v_id;
 if v_status<>'PENDING' then raise exception using errcode='22023',message='invitation_replayed'; end if;
 
 update private.employee_invitations set status='ACCEPTED',accepted_at=now() where id=v_id;
 v_status:='ACCEPTED'; insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,v_actor,v_id,'INVITATION_ACCEPTED','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=v_id;
end;
$$;

create function private.start_employee_onboarding() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_id uuid;v_actor uuid;v_status text;
begin
v_id:=private.lock_my_invitation();
 select i.status,i.auth_user_id into v_status,v_actor from private.employee_invitations i where i.id=v_id;
 if v_status<>'ACCEPTED' then raise exception using errcode='22023',message='invitation_replayed'; end if;
 if not (select a.password_set from private.invitation_identity() a) then raise exception using errcode='22023',message='password_required'; end if;
 update private.employee_invitations set status='ONBOARDING' where id=v_id;
 v_status:='ONBOARDING'; insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,v_actor,v_id,'ONBOARDING_STARTED','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=v_id;
end;
$$;

create function private.complete_employee_onboarding(p_full_name text) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_id uuid;v_actor uuid;v_inv private.employee_invitations%rowtype;v_status text:='COMPLETED';
begin
v_id:=private.lock_my_invitation();
 select i.* into v_inv from private.employee_invitations i where i.id=v_id;
 if v_inv.status<>'ONBOARDING' then raise exception using errcode='22023',message='invalid_invitation_state'; end if;
 if p_full_name is null or char_length(btrim(p_full_name)) not between 1 and 200 then raise exception using errcode='22023',message='invalid_full_name'; end if;
 if not (select a.password_set from private.invitation_identity() a) then raise exception using errcode='22023',message='password_required'; end if;
 update private.employee_invitations set status='COMPLETED',completed_at=now() where id=v_id;
 update public.profiles set full_name=btrim(p_full_name),role=v_inv.assigned_role,requires_onboarding=false,onboarded_at=now(),is_active=true where id=v_inv.auth_user_id and requires_onboarding;
 if not found then raise exception using errcode='22023',message='invitation_replayed'; end if;
 v_actor:=v_inv.auth_user_id; insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,v_actor,v_id,'ONBOARDING_COMPLETED','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=v_id;
end;
$$;

grant cyclo_employee_api to postgres with inherit false,set true;
grant create on schema private to cyclo_employee_api;
alter function private.admin_create_employee_invitation(text,text,public.app_role) owner to cyclo_employee_api;
alter function private.admin_list_employee_invitations() owner to cyclo_employee_api;
alter function private.admin_resend_employee_invitation(uuid) owner to cyclo_employee_api;
alter function private.admin_revoke_employee_invitation(uuid) owner to cyclo_employee_api;
alter function private.admin_record_invitation_delivery(uuid,boolean) owner to cyclo_employee_api;
alter function private.lock_my_invitation() owner to cyclo_employee_api;
alter function private.get_my_employee_invitation() owner to cyclo_employee_api;
alter function private.accept_employee_invitation() owner to cyclo_employee_api;
alter function private.start_employee_onboarding() owner to cyclo_employee_api;
alter function private.complete_employee_onboarding(text) owner to cyclo_employee_api;
set local role cyclo_employee_api;
revoke all on function private.admin_create_employee_invitation(text,text,public.app_role) from public,anon,authenticated,service_role;
grant execute on function private.admin_create_employee_invitation(text,text,public.app_role) to authenticated;
revoke all on function private.admin_list_employee_invitations() from public,anon,authenticated,service_role;
grant execute on function private.admin_list_employee_invitations() to authenticated;
revoke all on function private.admin_resend_employee_invitation(uuid) from public,anon,authenticated,service_role;
grant execute on function private.admin_resend_employee_invitation(uuid) to authenticated;
revoke all on function private.admin_revoke_employee_invitation(uuid) from public,anon,authenticated,service_role;
grant execute on function private.admin_revoke_employee_invitation(uuid) to authenticated;
revoke all on function private.admin_record_invitation_delivery(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function private.admin_record_invitation_delivery(uuid,boolean) to authenticated;
revoke all on function private.lock_my_invitation() from public,anon,authenticated,service_role;
revoke all on function private.get_my_employee_invitation() from public,anon,authenticated,service_role;
grant execute on function private.get_my_employee_invitation() to authenticated;
revoke all on function private.accept_employee_invitation() from public,anon,authenticated,service_role;
grant execute on function private.accept_employee_invitation() to authenticated;
revoke all on function private.start_employee_onboarding() from public,anon,authenticated,service_role;
grant execute on function private.start_employee_onboarding() to authenticated;
revoke all on function private.complete_employee_onboarding(text) from public,anon,authenticated,service_role;
grant execute on function private.complete_employee_onboarding(text) to authenticated;
reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;
create function public.admin_create_employee_invitation(p_email text,p_full_name text,p_role public.app_role) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.admin_create_employee_invitation(p_email,p_full_name,p_role) i $$;
revoke all on function public.admin_create_employee_invitation(text,text,public.app_role) from public,anon,authenticated,service_role;
grant execute on function public.admin_create_employee_invitation(text,text,public.app_role) to authenticated;
create function public.admin_list_employee_invitations() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.admin_list_employee_invitations() i $$;
revoke all on function public.admin_list_employee_invitations() from public,anon,authenticated,service_role;
grant execute on function public.admin_list_employee_invitations() to authenticated;
create function public.admin_resend_employee_invitation(p_invitation_id uuid) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.admin_resend_employee_invitation(p_invitation_id) i $$;
revoke all on function public.admin_resend_employee_invitation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_resend_employee_invitation(uuid) to authenticated;
create function public.admin_revoke_employee_invitation(p_invitation_id uuid) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.admin_revoke_employee_invitation(p_invitation_id) i $$;
revoke all on function public.admin_revoke_employee_invitation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_revoke_employee_invitation(uuid) to authenticated;
create function public.admin_record_invitation_delivery(p_invitation_id uuid,p_success boolean) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.admin_record_invitation_delivery(p_invitation_id,p_success) i $$;
revoke all on function public.admin_record_invitation_delivery(uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.admin_record_invitation_delivery(uuid,boolean) to authenticated;
create function public.get_my_employee_invitation() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.get_my_employee_invitation() i $$;
revoke all on function public.get_my_employee_invitation() from public,anon,authenticated,service_role;
grant execute on function public.get_my_employee_invitation() to authenticated;
create function public.accept_employee_invitation() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.accept_employee_invitation() i $$;
revoke all on function public.accept_employee_invitation() from public,anon,authenticated,service_role;
grant execute on function public.accept_employee_invitation() to authenticated;
create function public.start_employee_onboarding() returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.start_employee_onboarding() i $$;
revoke all on function public.start_employee_onboarding() from public,anon,authenticated,service_role;
grant execute on function public.start_employee_onboarding() to authenticated;
create function public.complete_employee_onboarding(p_full_name text) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language sql volatile security invoker set search_path='' as $$ select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.complete_employee_onboarding(p_full_name) i $$;
revoke all on function public.complete_employee_onboarding(text) from public,anon,authenticated,service_role;
grant execute on function public.complete_employee_onboarding(text) to authenticated;
notify pgrst,'reload schema';
commit;
