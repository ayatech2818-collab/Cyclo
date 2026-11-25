-- =============================================================================
-- CYCLO Phase 6: own profile and avatar selection (local deployment only)
--
-- Adds:
--   * public.profiles.avatar_kind / avatar_symbol / avatar_path
--       explicit, validated avatar selection: default | initials | image | emoji | icon
--   * private Storage bucket "avatars" (2 MiB, JPEG/PNG/WebP) and storage.objects
--     policies: employees write only "<own uuid>/<uuid>.<ext>"; reads follow the
--     directory rules (self, active SUPER_ADMIN, active PROJECT_MANAGER)
--   * RPCs (public SECURITY INVOKER wrappers over private SECURITY DEFINER code
--     owned by cyclo_employee_api):
--       get_employee_avatars(uuid[])   avatar state for self, or any id for SA/PM
--       update_my_profile(text)        own full name
--       set_my_avatar(text, text)      default | initials | image | emoji | icon
--       set_my_avatar_image(text)      attach an uploaded object the caller owns
--       remove_my_avatar_image()       detach the uploaded image
--   * audit actions SELF_PROFILE_UPDATED and SELF_AVATAR_UPDATED
--
-- Unchanged: existing RPC signatures and DTO columns, Phase 4 admin avatar_url
-- management, the existing own-row UPDATE (full_name, avatar_url) grant, RLS on
-- profiles, invitation/onboarding guards and last-active-Super-Admin protection.
--
-- Display priority (applied by the application, documented here):
--   image (with a readable object) > emoji/icon > admin avatar_url (only while
--   avatar_kind = 'default') > initials. avatar_kind = 'initials' is an explicit
--   choice and therefore also hides an administrator-managed avatar_url.
--
-- Symbol identifiers are allowlisted below and mirrored in
-- src/features/profile/avatar-catalog.ts (a unit test keeps the lists equal).
-- No markup, URLs or free text are ever stored for emoji/icon avatars.
-- =============================================================================
begin;

-- -----------------------------------------------------------------------------
-- 1. Avatar selection columns
--    CHECK constraints call no functions, so every writer (Auth triggers,
--    direct own-row updates, RPC owner) is validated without extra grants.
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column avatar_kind text not null default 'default',
  add column avatar_symbol text,
  add column avatar_path text;

alter table public.profiles
  add constraint profiles_avatar_kind_valid check (
    avatar_kind in ('default', 'initials', 'image', 'emoji', 'icon')
  ),
  add constraint profiles_avatar_symbol_valid check (
    -- "is not null" keeps a NULL symbol from turning the whole check into NULL (= pass).
    (avatar_kind = 'emoji' and avatar_symbol is not null and avatar_symbol = any (array[
      'rocket','laptop','sparkles','fire','star','rainbow','sun','moon',
      'cat','dog','fox','panda','owl','octopus','unicorn','coffee',
      'pizza','seedling','bolt','target','brain','robot','alien','gem'
    ]::text[]))
    or (avatar_kind = 'icon' and avatar_symbol is not null and avatar_symbol = any (array[
      'code','terminal','cpu','database','git-branch','bug','rocket','zap',
      'coffee','palette','compass','shield','cloud','globe','layers','wrench',
      'lightbulb','headphones','camera','book-open','heart','star','leaf','sparkles'
    ]::text[]))
    or (avatar_kind not in ('emoji', 'icon') and avatar_symbol is null)
  ),
  add constraint profiles_avatar_path_valid check (
    avatar_path is null
    or avatar_path ~ ('^' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$')
  ),
  add constraint profiles_avatar_image_has_path check (
    avatar_kind <> 'image' or avatar_path is not null
  );

comment on column public.profiles.avatar_kind is
  'Explicit avatar selection: default (admin avatar_url, else initials) | initials | image | emoji | icon.';
comment on column public.profiles.avatar_symbol is
  'Allowlisted emoji or Lucide icon identifier when avatar_kind is emoji or icon; never markup.';
comment on column public.profiles.avatar_path is
  'Object name in the private avatars bucket (<profile id>/<uuid>.<ext>); never a URL.';

-- The RPC owner may change only the new selection columns (full_name is
-- already granted by Phase 4). Direct authenticated access is not widened.
grant update (avatar_kind, avatar_symbol, avatar_path) on public.profiles to cyclo_employee_api;


-- -----------------------------------------------------------------------------
-- 2. Audit actions for self-service changes (target = the caller)
-- -----------------------------------------------------------------------------
alter table private.employee_audit_log drop constraint employee_audit_log_action_check;
alter table private.employee_audit_log add constraint employee_audit_log_action_check check (action in (
  'EMPLOYEE_PROFILE_UPDATED','EMPLOYEE_CODE_UPDATED','EMPLOYEE_ROLE_CHANGED','EMPLOYEE_ACTIVATED','EMPLOYEE_DEACTIVATED','GIT_ORGANIZER_GRANTED','GIT_ORGANIZER_REVOKED',
  'INVITATION_CREATED','INVITATION_RESENT','INVITATION_REVOKED','INVITATION_ACCEPTED','ONBOARDING_STARTED','ONBOARDING_COMPLETED',
  'SELF_PROFILE_UPDATED','SELF_AVATAR_UPDATED'));
alter table private.employee_audit_log drop constraint employee_audit_target_required;
alter table private.employee_audit_log add constraint employee_audit_target_required check (
  (invitation_id is not null and action in ('INVITATION_CREATED','INVITATION_RESENT','INVITATION_REVOKED','INVITATION_ACCEPTED','ONBOARDING_STARTED','ONBOARDING_COMPLETED')) or
  (target_employee_id is not null and action in ('EMPLOYEE_PROFILE_UPDATED','EMPLOYEE_CODE_UPDATED','EMPLOYEE_ROLE_CHANGED','EMPLOYEE_ACTIVATED','EMPLOYEE_DEACTIVATED','GIT_ORGANIZER_GRANTED','GIT_ORGANIZER_REVOKED')) or
  (target_employee_id is not null and target_employee_id = actor_id and action in ('SELF_PROFILE_UPDATED','SELF_AVATAR_UPDATED')));


-- -----------------------------------------------------------------------------
-- 3. Private avatars bucket
--    2 MiB per object, raster formats only (no SVG, no GIF). Storage enforces
--    size and MIME type at upload; the application also checks file signatures.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- -----------------------------------------------------------------------------
-- 4. storage.objects policies for the avatars bucket
--    Object names are exactly "<auth.uid()>/<uuid>.<jpg|png|webp>". There is no
--    UPDATE policy: an upload never overwrites, a replacement is a new object.
--    private.current_app_role() is NULL for inactive, unonboarded or unknown
--    callers, so only active employees can upload, read or delete.
-- -----------------------------------------------------------------------------
create policy "Active employees upload their own avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (select private.current_app_role()) is not null
    and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$')
  );

create policy "Active employees read permitted avatars"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      ((select private.current_app_role()) is not null
        and pg_catalog.split_part(name, '/', 1) = (select auth.uid())::text)
      or (select private.current_app_role()) in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role)
    )
  );

create policy "Active employees delete their own avatar"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (select private.current_app_role()) is not null
    and pg_catalog.split_part(name, '/', 1) = (select auth.uid())::text
  );


-- -----------------------------------------------------------------------------
-- 5. Trusted Storage bridge (owner postgres, like private.request_user_id)
--    Reveals only whether the caller owns a given object in the avatars bucket.
--    Executable by the RPC owner role only.
-- -----------------------------------------------------------------------------
create function private.my_avatar_object_exists(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from storage.objects as o
     where o.bucket_id = 'avatars'
       and o.name = p_path
       and o.owner_id = (select auth.uid())::text
  )
$$;
revoke all on function private.my_avatar_object_exists(text) from public, anon, authenticated, service_role;
grant execute on function private.my_avatar_object_exists(text) to cyclo_employee_api;


-- -----------------------------------------------------------------------------
-- 6. Private implementations, created directly as cyclo_employee_api
--    (same temporary SET/CREATE pattern as the Phase 4 hardening migration).
-- -----------------------------------------------------------------------------
grant cyclo_employee_api to postgres with inherit false, set true;
grant create on schema private to cyclo_employee_api;
set local role cyclo_employee_api;

-- Avatar state. SA/PM may read any employee (directory rules); everyone else
-- only receives their own row, whatever ids they pass.
create function private.get_employee_avatars(p_employee_ids uuid[])
returns table (id uuid, avatar_kind text, avatar_symbol text, avatar_path text, avatar_url text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_actor uuid := private.require_employee_actor(
    array['SUPER_ADMIN','PROJECT_MANAGER','DEVELOPER']::public.app_role[]);
  v_directory boolean;
begin
  if p_employee_ids is null or pg_catalog.cardinality(p_employee_ids) > 100 then
    raise exception using errcode = '22023', message = 'invalid_employee_ids';
  end if;
  select p.role in ('SUPER_ADMIN'::public.app_role, 'PROJECT_MANAGER'::public.app_role)
    into v_directory from public.profiles as p where p.id = v_actor;
  return query
    select p.id, p.avatar_kind, p.avatar_symbol, p.avatar_path, p.avatar_url
      from public.profiles as p
     where p.id = any (p_employee_ids)
       and (v_directory or p.id = v_actor)
     order by p.id;
end;
$$;

-- Locks and returns the caller's own row; rejects inactive callers.
create function private.lock_self_profile()
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := private.require_employee_actor(
  array['SUPER_ADMIN','PROJECT_MANAGER','DEVELOPER']::public.app_role[]);
begin
  perform 1 from public.profiles as p where p.id = v_actor for update;
  -- Re-check after the lock: a concurrent deactivation must win.
  if not exists (select 1 from public.profiles as p where p.id = v_actor and p.is_active) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return v_actor;
end;
$$;

create function private.update_my_profile(p_full_name text)
returns table (full_name text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_actor uuid := private.lock_self_profile();
  v_name text := pg_catalog.regexp_replace(p_full_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_old text;
begin
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid_full_name';
  end if;
  select p.full_name into v_old from public.profiles as p where p.id = v_actor;
  if v_old is distinct from v_name then
    update public.profiles as p set full_name = v_name where p.id = v_actor;
    insert into private.employee_audit_log (actor_id, target_employee_id, action, old_values, new_values)
      values (v_actor, v_actor, 'SELF_PROFILE_UPDATED',
              pg_catalog.jsonb_build_object('full_name', v_old),
              pg_catalog.jsonb_build_object('full_name', v_name));
  end if;
  return query select p.full_name from public.profiles as p where p.id = v_actor;
end;
$$;

-- Shared write + audit for every avatar change. Returns the previous image path
-- when it is no longer referenced, so the caller can delete that object.
create function private.apply_my_avatar(p_actor uuid, p_kind text, p_symbol text, p_path text)
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_old record;
  v_constraint text;
begin
  select p.avatar_kind, p.avatar_symbol, p.avatar_path into v_old
    from public.profiles as p where p.id = p_actor;
  if v_old.avatar_kind is distinct from p_kind
     or v_old.avatar_symbol is distinct from p_symbol
     or v_old.avatar_path is distinct from p_path then
    begin
      update public.profiles as p
         set avatar_kind = p_kind, avatar_symbol = p_symbol, avatar_path = p_path
       where p.id = p_actor;
    exception when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'profiles_avatar_symbol_valid' then
        raise exception using errcode = '22023', message = 'invalid_avatar_symbol';
      elsif v_constraint = 'profiles_avatar_path_valid' then
        raise exception using errcode = '22023', message = 'invalid_avatar_path';
      end if;
      raise;
    end;
    insert into private.employee_audit_log (actor_id, target_employee_id, action, old_values, new_values)
      values (p_actor, p_actor, 'SELF_AVATAR_UPDATED',
              pg_catalog.jsonb_build_object('avatar_kind', v_old.avatar_kind, 'avatar_symbol', v_old.avatar_symbol, 'avatar_path', v_old.avatar_path),
              pg_catalog.jsonb_build_object('avatar_kind', p_kind, 'avatar_symbol', p_symbol, 'avatar_path', p_path));
  end if;
  return query select p_kind, p_symbol, p_path,
    case when v_old.avatar_path is distinct from p_path then v_old.avatar_path end;
end;
$$;

-- Select default, initials, emoji, icon, or switch back to an already uploaded image.
create function private.set_my_avatar(p_kind text, p_symbol text)
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_actor uuid := private.lock_self_profile();
  v_path text;
begin
  if p_kind is null or p_kind not in ('default','initials','image','emoji','icon') then
    raise exception using errcode = '22023', message = 'invalid_avatar_kind';
  end if;
  if (p_kind in ('emoji','icon')) <> (p_symbol is not null)
     or (p_symbol is not null and p_symbol !~ '^[a-z][a-z0-9-]{0,31}$') then
    raise exception using errcode = '22023', message = 'invalid_avatar_symbol';
  end if;
  select p.avatar_path into v_path from public.profiles as p where p.id = v_actor;
  if p_kind = 'image' and v_path is null then
    raise exception using errcode = '22023', message = 'avatar_image_missing';
  end if;
  -- The uploaded image is kept so the employee can switch back to it.
  return query select * from private.apply_my_avatar(v_actor, p_kind, p_symbol, v_path);
end;
$$;

-- Attach a freshly uploaded object. The object must already exist in the
-- avatars bucket under the caller's folder and be owned by the caller.
create function private.set_my_avatar_image(p_path text)
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare v_actor uuid := private.lock_self_profile();
begin
  if p_path is null
     or p_path !~ ('^' || v_actor::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') then
    raise exception using errcode = '22023', message = 'invalid_avatar_path';
  end if;
  if not private.my_avatar_object_exists(p_path) then
    raise exception using errcode = '22023', message = 'avatar_object_missing';
  end if;
  return query select * from private.apply_my_avatar(v_actor, 'image', null, p_path);
end;
$$;

-- Detach the uploaded image; an image selection falls back to default.
create function private.remove_my_avatar_image()
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_actor uuid := private.lock_self_profile();
  v_kind text;
  v_symbol text;
begin
  select p.avatar_kind, p.avatar_symbol into v_kind, v_symbol from public.profiles as p where p.id = v_actor;
  if v_kind = 'image' then v_kind := 'default'; end if;
  return query select * from private.apply_my_avatar(v_actor, v_kind, v_symbol, null);
end;
$$;

revoke all on function private.get_employee_avatars(uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.lock_self_profile() from public, anon, authenticated, service_role;
revoke all on function private.update_my_profile(text) from public, anon, authenticated, service_role;
revoke all on function private.apply_my_avatar(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.set_my_avatar(text, text) from public, anon, authenticated, service_role;
revoke all on function private.set_my_avatar_image(text) from public, anon, authenticated, service_role;
revoke all on function private.remove_my_avatar_image() from public, anon, authenticated, service_role;

-- Reachable only through the public wrappers (private schema is not exposed).
-- lock_self_profile and apply_my_avatar stay owner-only: apply_my_avatar takes
-- an actor id and must never be callable directly.
grant execute on function private.get_employee_avatars(uuid[]) to authenticated;
grant execute on function private.update_my_profile(text) to authenticated;
grant execute on function private.set_my_avatar(text, text) to authenticated;
grant execute on function private.set_my_avatar_image(text) to authenticated;
grant execute on function private.remove_my_avatar_image() to authenticated;

reset role;
revoke create on schema private from cyclo_employee_api;
revoke cyclo_employee_api from postgres;


-- -----------------------------------------------------------------------------
-- 7. Public RPC wrappers (SECURITY INVOKER, exposed through the Data API)
-- -----------------------------------------------------------------------------
create function public.get_employee_avatars(p_employee_ids uuid[])
returns table (id uuid, avatar_kind text, avatar_symbol text, avatar_path text, avatar_url text)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.avatar_kind, a.avatar_symbol, a.avatar_path, a.avatar_url
    from private.get_employee_avatars(p_employee_ids) as a
$$;

create function public.update_my_profile(p_full_name text)
returns table (full_name text)
language sql volatile security invoker set search_path = '' as $$
  select r.full_name from private.update_my_profile(p_full_name) as r
$$;

create function public.set_my_avatar(p_kind text, p_symbol text default null)
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language sql volatile security invoker set search_path = '' as $$
  select r.avatar_kind, r.avatar_symbol, r.avatar_path, r.previous_path
    from private.set_my_avatar(p_kind, p_symbol) as r
$$;

create function public.set_my_avatar_image(p_path text)
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language sql volatile security invoker set search_path = '' as $$
  select r.avatar_kind, r.avatar_symbol, r.avatar_path, r.previous_path
    from private.set_my_avatar_image(p_path) as r
$$;

create function public.remove_my_avatar_image()
returns table (avatar_kind text, avatar_symbol text, avatar_path text, previous_path text)
language sql volatile security invoker set search_path = '' as $$
  select r.avatar_kind, r.avatar_symbol, r.avatar_path, r.previous_path
    from private.remove_my_avatar_image() as r
$$;

revoke all on function public.get_employee_avatars(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.update_my_profile(text) from public, anon, authenticated, service_role;
revoke all on function public.set_my_avatar(text, text) from public, anon, authenticated, service_role;
revoke all on function public.set_my_avatar_image(text) from public, anon, authenticated, service_role;
revoke all on function public.remove_my_avatar_image() from public, anon, authenticated, service_role;
grant execute on function public.get_employee_avatars(uuid[]) to authenticated;
grant execute on function public.update_my_profile(text) to authenticated;
grant execute on function public.set_my_avatar(text, text) to authenticated;
grant execute on function public.set_my_avatar_image(text) to authenticated;
grant execute on function public.remove_my_avatar_image() to authenticated;

comment on function public.get_employee_avatars(uuid[]) is
  'Avatar selection state. Active SA/PM: any ids (max 100). Other active employees: own row only.';
comment on function public.update_my_profile(text) is 'Caller''s own full name. Any active employee. Audited.';
comment on function public.set_my_avatar(text, text) is 'Caller''s avatar selection (default|initials|image|emoji|icon). Audited.';
comment on function public.set_my_avatar_image(text) is 'Attach an uploaded avatar object the caller owns. Audited.';
comment on function public.remove_my_avatar_image() is 'Detach the caller''s uploaded avatar image. Audited.';

commit;

-- =============================================================================
-- ROLLBACK (manual; run as postgres only if this migration must be undone)
--
-- drop function if exists public.remove_my_avatar_image(), public.set_my_avatar_image(text),
--   public.set_my_avatar(text, text), public.update_my_profile(text), public.get_employee_avatars(uuid[]);
-- grant cyclo_employee_api to postgres with inherit false, set true;
-- drop function if exists private.remove_my_avatar_image(), private.set_my_avatar_image(text),
--   private.set_my_avatar(text, text), private.apply_my_avatar(uuid, text, text, text),
--   private.update_my_profile(text), private.lock_self_profile(), private.get_employee_avatars(uuid[]);
-- revoke cyclo_employee_api from postgres;
-- drop function if exists private.my_avatar_object_exists(text);
-- drop policy if exists "Active employees delete their own avatar" on storage.objects;
-- drop policy if exists "Active employees read permitted avatars" on storage.objects;
-- drop policy if exists "Active employees upload their own avatar" on storage.objects;
-- (empty the avatars bucket through the Storage API, then) delete from storage.buckets where id = 'avatars';
-- restore the two employee_audit_log constraints from 20261121101643 (only if no SELF_* rows exist);
-- revoke update (avatar_kind, avatar_symbol, avatar_path) on public.profiles from cyclo_employee_api;
-- alter table public.profiles drop column avatar_path, drop column avatar_symbol, drop column avatar_kind;
-- =============================================================================
