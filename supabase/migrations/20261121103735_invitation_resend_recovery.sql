-- Resend restores access to onboarding without replaying acceptance.
begin;
grant cyclo_employee_api to postgres with inherit false,set true;
grant create on schema private to cyclo_employee_api;
set local role cyclo_employee_api;
create or replace function private.admin_resend_employee_invitation(p_invitation_id uuid) returns table(id uuid,email text,full_name text,assigned_role public.app_role,inviter_id uuid,auth_user_id uuid,status text,created_at timestamptz,expires_at timestamptz,accepted_at timestamptz,completed_at timestamptz,last_sent_at timestamptz,delivery_failed boolean) language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;v_inv private.employee_invitations%rowtype;v_status text:='PENDING';
begin
v_actor := private.request_user_id();
 if v_actor is null then raise exception using errcode='42501',message='unauthenticated'; end if;
 perform private.lock_employee_admin_target(v_actor);
 select i.* into v_inv from private.employee_invitations i where i.id=p_invitation_id for update;
 if not found then raise exception using errcode='P0002',message='invitation_not_found'; end if;
 if v_inv.status not in ('PENDING','ACCEPTED','ONBOARDING','EXPIRED') then raise exception using errcode='22023',message='invalid_invitation_state'; end if;
 if v_inv.last_sent_at>now()-interval '60 seconds' then raise exception using errcode='22023',message='resend_too_soon'; end if;
 v_status:=case when v_inv.status in ('ACCEPTED','ONBOARDING') then v_inv.status else 'PENDING' end;
 update private.employee_invitations set status=v_status,expires_at=now()+interval '1 hour',delivery_failed=false where id=p_invitation_id;
 insert into private.employee_audit_log(actor_id,target_employee_id,invitation_id,action,old_values,new_values) values(v_actor,null,p_invitation_id,'INVITATION_RESENT','{}',jsonb_build_object('status',v_status));
 return query select i.id,i.email,i.full_name,i.assigned_role,i.inviter_id,i.auth_user_id,i.status,i.created_at,i.expires_at,i.accepted_at,i.completed_at,i.last_sent_at,i.delivery_failed from private.employee_invitations i where i.id=p_invitation_id;
end;
$$;
reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;
commit;
