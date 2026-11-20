-- CYCLO: protect the last active Super Admin.
-- New forward-only migration. Run as the trusted postgres migration role.

begin isolation level read committed;
set local role postgres;

-- Block profile writes while seeding the counter and installing triggers.
lock table public.profiles in share row exclusive mode;

create table private.super_admin_guard (
  singleton boolean primary key default true
    constraint super_admin_guard_singleton check (singleton),
  active_count bigint not null
    constraint super_admin_guard_nonnegative check (active_count >= 0)
);

comment on table private.super_admin_guard is
  'Internal active Super Admin counter and serialization row. '
  'Maintained by profile triggers; repair through the maintenance function.';

revoke all on table private.super_admin_guard
  from public, anon, authenticated, service_role;

alter table private.super_admin_guard enable row level security;

-- Permit initial bootstrap when no active Super Admin exists.
insert into private.super_admin_guard (singleton, active_count)
select true, count(*)
from public.profiles
where role = 'SUPER_ADMIN'::public.app_role
  and is_active;

create function private.protect_last_active_super_admin()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
set row_security = off
as $$
declare
  membership_delta integer := 0;
begin
  if TG_OP = 'TRUNCATE' then
    raise exception using
      errcode = '23514',
      message =
        'Cannot truncate employee profiles. Use guarded DELETE operations.',
      constraint = 'profiles_no_truncate';
  end if;

  if TG_OP <> 'INSERT' then
    if OLD.role = 'SUPER_ADMIN'::public.app_role and OLD.is_active then
      membership_delta := membership_delta - 1;
    end if;
  end if;

  if TG_OP <> 'DELETE' then
    if NEW.role = 'SUPER_ADMIN'::public.app_role and NEW.is_active then
      membership_delta := membership_delta + 1;
    end if;
  end if;

  if membership_delta = 0 then
    return null;
  end if;

  -- Atomic modification of one shared row serializes membership changes.
  update private.super_admin_guard
     set active_count = active_count + membership_delta
   where singleton
     and active_count + membership_delta >= 1;

  if not found then
    if not exists (
      select 1
      from private.super_admin_guard
      where singleton
    ) then
      raise exception using
        errcode = '55000',
        message =
          'Super Admin counter is missing. '
          'A database administrator must verify and repair it.';
    end if;

    raise exception using
      errcode = '23514',
      message =
        'Cannot deactivate, demote, or delete the last active Super Admin.',
      constraint = 'profiles_last_active_super_admin',
      schema = 'public',
      table = 'profiles';
  end if;

  -- Return value is ignored for AFTER triggers.
  return null;
end;
$$;

revoke all on function private.protect_last_active_super_admin()
  from public, anon, authenticated, service_role;

create trigger profiles_protect_last_active_super_admin
  after insert or update or delete
  on public.profiles
  for each row
  execute function private.protect_last_active_super_admin();

create trigger profiles_prevent_truncate
  before truncate
  on public.profiles
  for each statement
  execute function private.protect_last_active_super_admin();

alter table public.profiles
  enable always trigger profiles_protect_last_active_super_admin;

alter table public.profiles
  enable always trigger profiles_prevent_truncate;

-- Owner-only maintenance function; deliberately grants no elevated access.
create function private.verify_super_admin_counter(
  p_repair boolean default false
)
returns table (
  recorded_before bigint,
  actual_count bigint,
  was_consistent boolean,
  repaired boolean
)
language plpgsql
volatile
security invoker
set search_path = ''
set row_security = off
as $$
begin
  if p_repair is null then
    raise exception using
      errcode = '22004',
      message = 'p_repair must be true or false.';
  end if;

  if pg_catalog.current_setting('transaction_isolation')
       <> 'read committed' then
    raise exception using
      errcode = '25001',
      message =
        'Counter verification requires a Read Committed transaction.';
  end if;

  -- Always lock profiles first, then the counter.
  -- Wait for existing profile writers and prevent new writers.
  lock table public.profiles in share row exclusive mode;
  lock table private.super_admin_guard in share row exclusive mode;

  select g.active_count
    into recorded_before
    from private.super_admin_guard as g
   where g.singleton;

  select count(*)
    into actual_count
    from public.profiles as p
   where p.role = 'SUPER_ADMIN'::public.app_role
     and p.is_active;

  was_consistent :=
    recorded_before is not distinct from actual_count;
  repaired := false;

  if p_repair and not was_consistent then
    insert into private.super_admin_guard (
      singleton,
      active_count
    )
    values (true, actual_count)
    on conflict (singleton)
    do update set active_count = excluded.active_count;

    repaired := true;
  end if;

  return next;
end;
$$;

revoke all on function private.verify_super_admin_counter(boolean)
  from public, anon, authenticated, service_role;

comment on function private.verify_super_admin_counter(boolean) is
  'Owner-only verification/recovery. Invoke as a standalone maintenance '
  'statement under Read Committed, not from profile DML or triggers. '
  'Locks persist until transaction end. Zero actual admins require '
  'separate first-admin provisioning; profiles are never changed here.';

commit;
