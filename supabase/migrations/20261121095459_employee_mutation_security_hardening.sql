-- Phase 4 review fixes. Existing migrations, wrappers, RLS and audit grants are unchanged.
begin;
grant cyclo_employee_api to postgres with inherit false, set true;
grant create on schema private to cyclo_employee_api;
set local role cyclo_employee_api;

-- Deliberate URL subset shared with avatar-url-policy.ts; no network lookups.
-- NULL/empty clears the avatar. URL whitespace is rejected, never trimmed.
create function private.is_valid_employee_avatar_url(p_url text)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  v_parts text[];
  v_authority text;
  v_host text;
  v_dns text;
  v_label text;
  v_labels text[];
  v_port text;
  v_ip pg_catalog.inet;
  v_octet text;
begin
  if p_url is null or p_url = '' then return true; end if;
  if pg_catalog.char_length(p_url) > 2048
     or p_url ~ U&'[\0001-\0020\007F-\009F\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
     or pg_catalog.strpos(p_url, pg_catalog.chr(92)) > 0 then return false; end if;
  v_parts := pg_catalog.regexp_match(p_url, '^https://([^/?#]+)([/?#].*)?$', 'i');
  if v_parts is null then return false; end if;
  v_authority := v_parts[1];
  if pg_catalog.strpos(v_authority, '@') > 0 then return false; end if;
  if pg_catalog.left(v_authority,1) = '[' then
    v_parts := pg_catalog.regexp_match(v_authority, '^\[([^\]]+)\](:([0-9]+))?$');
    if v_parts is null then return false; end if;
    v_host := v_parts[1]; v_port := v_parts[3];
    -- inet accepts prefixes; a URL host must be an address, never a subnet.
    if v_host !~ '^[0-9A-Fa-f:.]+$' then return false; end if;
    if pg_catalog.strpos(v_host,'.') > 0 then
      v_label := pg_catalog.substring(v_host, '[^:]+$');
      if v_label !~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$' then return false; end if;
      foreach v_octet in array pg_catalog.string_to_array(v_label,'.') loop
        if v_octet::integer > 255 then return false; end if;
      end loop;
    end if;
    begin
      v_ip := v_host::pg_catalog.inet;
    exception when invalid_text_representation then return false;
    end;
    if pg_catalog.family(v_ip) <> 6 then return false; end if;
  else
    v_parts := pg_catalog.regexp_match(v_authority, '^([^:]+)(:([0-9]+))?$');
    if v_parts is null then return false; end if;
    v_host := v_parts[1]; v_port := v_parts[3];
    if v_host ~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$' then
      foreach v_octet in array pg_catalog.string_to_array(v_host,'.') loop
        if v_octet::integer > 255 then return false; end if;
      end loop;
    else
      v_dns := v_host;
      if pg_catalog.right(v_dns,1) = '.' then v_dns := pg_catalog.left(v_dns,-1); end if;
      if v_dns = '' or pg_catalog.char_length(v_dns) > 253 then return false; end if;
      v_labels := pg_catalog.string_to_array(v_dns,'.');
      if v_labels[pg_catalog.array_length(v_labels,1)] ~* '^([0-9]+|0x[0-9a-f]+)$' then return false; end if;
      foreach v_label in array v_labels loop
        if v_label !~* '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then return false; end if;
      end loop;
    end if;
  end if;
  if v_port is not null then
    v_port := pg_catalog.ltrim(v_port,'0');
    if v_port = '' or pg_catalog.char_length(v_port) > 5 then return false; end if;
    if v_port::integer not between 1 and 65535 then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function private.is_valid_employee_avatar_url(text) from public,anon,authenticated,service_role;

create or replace function private.lock_employee_admin_target(p_employee_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := private.request_user_id();
begin
  if v_actor is null then
    raise exception using errcode='42501', message='unauthenticated';
  end if;
  if p_employee_id is null then
    raise exception using errcode='22023', message='invalid_employee_id';
  end if;
  -- Early rejection avoids touching target locks for unauthorized callers.
  -- This is not the authoritative check: role/status can change while waiting.
  if not exists (select 1 from public.profiles p
    where p.id=v_actor and p.is_active and p.role='SUPER_ADMIN'::public.app_role) then
    raise exception using errcode='42501', message='forbidden';
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

create or replace function private.admin_update_employee_details(p_employee_id uuid, p_full_name text, p_avatar_url text)
returns table (id uuid, full_name text, avatar_url text, email text, employee_code text,
  role public.app_role, is_active boolean, is_git_organizer boolean,
  invited_by uuid, invited_by_name text, onboarded_at timestamptz,
  created_at timestamptz, updated_at timestamptz) language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid; v_old jsonb; v_new jsonb; v_name text := pg_catalog.regexp_replace(p_full_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_avatar text := nullif(p_avatar_url,'');
begin
  v_actor := private.lock_employee_admin_target(p_employee_id);
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 200 then
    raise exception using errcode='22023', message='invalid_full_name'; end if;
  if not private.is_valid_employee_avatar_url(v_avatar) then
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

reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;
notify pgrst, 'reload schema';
commit;
