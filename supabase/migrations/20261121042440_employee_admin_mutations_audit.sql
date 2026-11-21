-- Phase 4: narrowly scoped employee administration and atomic audit.
-- Local deployment only. Existing migrations and last-admin protection are unchanged.
begin;
comment on role cyclo_employee_api is 'CYCLO employee RPC owner. NOLOGIN, no BYPASSRLS; SELECT and explicitly allowed UPDATE columns only. Never grant to login roles.';
create table private.employee_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  target_employee_id uuid not null,
  action text not null check (action in (
    'EMPLOYEE_PROFILE_UPDATED','EMPLOYEE_CODE_UPDATED','EMPLOYEE_ROLE_CHANGED',
    'EMPLOYEE_ACTIVATED','EMPLOYEE_DEACTIVATED','GIT_ORGANIZER_GRANTED','GIT_ORGANIZER_REVOKED')),
  old_values jsonb not null check (jsonb_typeof(old_values) = 'object'),
  new_values jsonb not null check (jsonb_typeof(new_values) = 'object'),
  created_at timestamptz not null default now()
);
comment on table private.employee_audit_log is
  'Append-only employee administration audit. UUIDs intentionally survive profile deletion; no credentials or whole rows.';
alter table private.employee_audit_log enable row level security;
revoke all on private.employee_audit_log from public, anon, authenticated, service_role, cyclo_employee_api;
grant insert (actor_id,target_employee_id,action,old_values,new_values)
  on private.employee_audit_log to cyclo_employee_api;
create policy employee_api_append_audit on private.employee_audit_log
  for insert to cyclo_employee_api with check (actor_id = private.request_user_id());
grant update (full_name,avatar_url,employee_code,role,is_active,is_git_organizer)
  on public.profiles to cyclo_employee_api;
create policy employee_api_update_profiles on public.profiles
  for update to cyclo_employee_api using (true) with check (true);
-- Locks precede authorization: a concurrent role/status change must finish
-- before the actor is re-read. UUID ordering avoids cross-admin deadlocks.
create function private.lock_employee_admin_target(p_employee_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := private.request_user_id();
begin
  if v_actor is null then
    raise exception using errcode='42501', message='unauthenticated';
  end if;
  if p_employee_id is null then
    raise exception using errcode='22023', message='invalid_employee_id';
  end if;
  perform p.id from public.profiles p where p.id in (v_actor,p_employee_id)
    order by p.id for update;
  if not exists (select 1 from public.profiles p
    where p.id=v_actor and p.is_active and p.role='SUPER_ADMIN'::public.app_role) then
    raise exception using errcode='42501', message='forbidden';
  end if;
  if not exists (select 1 from public.profiles p where p.id=p_employee_id) then
    raise exception using errcode='P0002', message='employee_not_found';
  end if;
  return v_actor;
end;
$$;
create function private.admin_update_employee_details(p_employee_id uuid, p_full_name text, p_avatar_url text)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb; v_name text := pg_catalog.regexp_replace(p_full_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_avatar text := nullif(pg_catalog.regexp_replace(p_avatar_url, '^[[:space:]]+|[[:space:]]+$', '', 'g'),'');
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 200 then
    raise exception using errcode='22023', message='invalid_full_name'; end if;
  if v_avatar is not null and (pg_catalog.char_length(v_avatar)>2048
    or v_avatar !~* '^https://[^[:space:]/?#]+[^[:space:]]*$') then
    raise exception using errcode='22023', message='invalid_avatar_url'; end if;
  select pg_catalog.jsonb_build_object('full_name',p.full_name,'avatar_url',p.avatar_url) into v_old
    from public.profiles p where p.id=p_employee_id;
  v_new := pg_catalog.jsonb_build_object('full_name',v_name,'avatar_url',v_avatar);
  if v_old is distinct from v_new then
    update public.profiles p set full_name=v_name, avatar_url=v_avatar where p.id=p_employee_id;
    insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values)
      -- Hash avatar URLs so signed URL tokens or URL credentials never enter audit history.
      values(v_actor,p_employee_id,'EMPLOYEE_PROFILE_UPDATED',pg_catalog.jsonb_build_object('full_name',v_old->'full_name','avatar_url_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_old->>'avatar_url','UTF8')),'hex')),pg_catalog.jsonb_build_object('full_name',v_new->'full_name','avatar_url_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_new->>'avatar_url','UTF8')),'hex')));
  end if;
  return query select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_get_employee(p_employee_id) e;
end;
$$;
create function private.admin_set_employee_code(p_employee_id uuid, p_employee_code text)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb; v_code text := nullif(pg_catalog.regexp_replace(p_employee_code, '^[[:space:]]+|[[:space:]]+$', '', 'g'),'');
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if v_code is not null and pg_catalog.char_length(v_code)>32 then
    raise exception using errcode='22023', message='invalid_employee_code'; end if;
  select pg_catalog.jsonb_build_object('employee_code',p.employee_code) into v_old
    from public.profiles p where p.id=p_employee_id;
  v_new := pg_catalog.jsonb_build_object('employee_code',v_code);
  if v_old is distinct from v_new then
    update public.profiles p set employee_code=v_code where p.id=p_employee_id;
    insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values)
      values(v_actor,p_employee_id,'EMPLOYEE_CODE_UPDATED',v_old,v_new);
  end if;
  return query select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_get_employee(p_employee_id) e;
end;
$$;
create function private.admin_set_employee_role(p_employee_id uuid, p_role public.app_role)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb;
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if p_role is null then raise exception using errcode='22023', message='invalid_role'; end if;
  if v_actor=p_employee_id and p_role <> 'SUPER_ADMIN'::public.app_role then
    raise exception using errcode='22023', message='self_demotion'; end if;
  select pg_catalog.jsonb_build_object('role',p.role) into v_old
    from public.profiles p where p.id=p_employee_id;
  v_new := pg_catalog.jsonb_build_object('role',p_role);
  if v_old is distinct from v_new then
    update public.profiles p set role=p_role where p.id=p_employee_id;
    insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values)
      values(v_actor,p_employee_id,'EMPLOYEE_ROLE_CHANGED',v_old,v_new);
  end if;
  return query select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_get_employee(p_employee_id) e;
end;
$$;
create function private.admin_set_employee_active(p_employee_id uuid, p_is_active boolean)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb;
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if p_is_active is null then raise exception using errcode='22023', message='invalid_status'; end if;
  if v_actor=p_employee_id and not p_is_active then
    raise exception using errcode='22023', message='self_deactivation'; end if;
  select pg_catalog.jsonb_build_object('is_active',p.is_active) into v_old
    from public.profiles p where p.id=p_employee_id;
  v_new := pg_catalog.jsonb_build_object('is_active',p_is_active);
  if v_old is distinct from v_new then
    update public.profiles p set is_active=p_is_active where p.id=p_employee_id;
    insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values)
      values(v_actor,p_employee_id,case when p_is_active then 'EMPLOYEE_ACTIVATED' else 'EMPLOYEE_DEACTIVATED' end,v_old,v_new);
  end if;
  return query select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_get_employee(p_employee_id) e;
end;
$$;
create function private.admin_set_git_organizer(p_employee_id uuid, p_is_git_organizer boolean)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb;
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if p_is_git_organizer is null then raise exception using errcode='22023', message='invalid_git_organizer'; end if;
  select pg_catalog.jsonb_build_object('is_git_organizer',p.is_git_organizer) into v_old
    from public.profiles p where p.id=p_employee_id;
  v_new := pg_catalog.jsonb_build_object('is_git_organizer',p_is_git_organizer);
  if v_old is distinct from v_new then
    update public.profiles p set is_git_organizer=p_is_git_organizer where p.id=p_employee_id;
    insert into private.employee_audit_log(actor_id,target_employee_id,action,old_values,new_values)
      values(v_actor,p_employee_id,case when p_is_git_organizer then 'GIT_ORGANIZER_GRANTED' else 'GIT_ORGANIZER_REVOKED' end,v_old,v_new);
  end if;
  return query select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_get_employee(p_employee_id) e;
end;
$$;
-- Temporary ownership-transfer privileges follow the Phase 2 pattern.
grant cyclo_employee_api to postgres with inherit false, set true;
grant create on schema private to cyclo_employee_api;
alter function private.lock_employee_admin_target(uuid) owner to cyclo_employee_api;
alter function private.admin_update_employee_details(uuid, text, text) owner to cyclo_employee_api;
alter function private.admin_set_employee_code(uuid, text) owner to cyclo_employee_api;
alter function private.admin_set_employee_role(uuid, public.app_role) owner to cyclo_employee_api;
alter function private.admin_set_employee_active(uuid, boolean) owner to cyclo_employee_api;
alter function private.admin_set_git_organizer(uuid, boolean) owner to cyclo_employee_api;
set role cyclo_employee_api;
revoke all on function private.lock_employee_admin_target(uuid) from public,anon,authenticated,service_role;
revoke all on function private.admin_update_employee_details(uuid, text, text) from public,anon,authenticated,service_role;
revoke all on function private.admin_set_employee_code(uuid, text) from public,anon,authenticated,service_role;
revoke all on function private.admin_set_employee_role(uuid, public.app_role) from public,anon,authenticated,service_role;
revoke all on function private.admin_set_employee_active(uuid, boolean) from public,anon,authenticated,service_role;
revoke all on function private.admin_set_git_organizer(uuid, boolean) from public,anon,authenticated,service_role;
grant execute on function private.admin_update_employee_details(uuid, text, text) to authenticated;
grant execute on function private.admin_set_employee_code(uuid, text) to authenticated;
grant execute on function private.admin_set_employee_role(uuid, public.app_role) to authenticated;
grant execute on function private.admin_set_employee_active(uuid, boolean) to authenticated;
grant execute on function private.admin_set_git_organizer(uuid, boolean) to authenticated;
reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;
create function public.admin_update_employee_details(p_employee_id uuid, p_full_name text, p_avatar_url text)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language sql volatile security invoker set search_path = '' as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_update_employee_details(p_employee_id,p_full_name,p_avatar_url) e
$$;
revoke all on function public.admin_update_employee_details(uuid, text, text) from public,anon,authenticated,service_role;
grant execute on function public.admin_update_employee_details(uuid, text, text) to authenticated;
create function public.admin_set_employee_code(p_employee_id uuid, p_employee_code text)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language sql volatile security invoker set search_path = '' as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_set_employee_code(p_employee_id,p_employee_code) e
$$;
revoke all on function public.admin_set_employee_code(uuid, text) from public,anon,authenticated,service_role;
grant execute on function public.admin_set_employee_code(uuid, text) to authenticated;
create function public.admin_set_employee_role(p_employee_id uuid, p_role public.app_role)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language sql volatile security invoker set search_path = '' as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_set_employee_role(p_employee_id,p_role) e
$$;
revoke all on function public.admin_set_employee_role(uuid, public.app_role) from public,anon,authenticated,service_role;
grant execute on function public.admin_set_employee_role(uuid, public.app_role) to authenticated;
create function public.admin_set_employee_active(p_employee_id uuid, p_is_active boolean)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language sql volatile security invoker set search_path = '' as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_set_employee_active(p_employee_id,p_is_active) e
$$;
revoke all on function public.admin_set_employee_active(uuid, boolean) from public,anon,authenticated,service_role;
grant execute on function public.admin_set_employee_active(uuid, boolean) to authenticated;
create function public.admin_set_git_organizer(p_employee_id uuid, p_is_git_organizer boolean)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language sql volatile security invoker set search_path = '' as $$
  select e.id, e.full_name, e.avatar_url, e.email, e.employee_code, e.role, e.is_active, e.is_git_organizer, e.invited_by, e.invited_by_name, e.onboarded_at, e.created_at, e.updated_at from private.admin_set_git_organizer(p_employee_id,p_is_git_organizer) e
$$;
revoke all on function public.admin_set_git_organizer(uuid, boolean) from public,anon,authenticated,service_role;
grant execute on function public.admin_set_git_organizer(uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
