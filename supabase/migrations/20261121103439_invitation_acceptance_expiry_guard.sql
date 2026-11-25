-- Expiry and identity are authoritative after lock acquisition, not transaction start.
begin;
grant cyclo_employee_api to postgres with inherit false,set true;
grant create on schema private to cyclo_employee_api;
set local role cyclo_employee_api;
create or replace function private.lock_my_invitation() returns uuid language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_column
declare v_actor uuid;v_email text;v_password boolean;v_inv private.employee_invitations%rowtype;
begin
select a.user_id,a.email,a.password_set into v_actor,v_email,v_password from private.invitation_identity() a;
 if v_actor is null then raise exception using errcode='42501',message='forbidden'; end if;
 select i.* into v_inv from private.employee_invitations i where i.auth_user_id=v_actor and i.email=v_email for update;
 if not found or v_inv.status in ('REVOKED','EXPIRED','COMPLETED') or v_inv.expires_at<=pg_catalog.clock_timestamp() then raise exception using errcode='42501',message='invalid_invitation'; end if;
 -- Email may have changed while waiting. Re-read confirmed Auth identity.
 if not exists(select 1 from private.invitation_identity() a where a.user_id=v_actor and a.email=v_inv.email) then
  raise exception using errcode='42501',message='invalid_invitation';
 end if;
 return v_inv.id;
end;
$$;
reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;
commit;
