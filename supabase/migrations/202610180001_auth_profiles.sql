-- Phase 1 authentication profiles. Review and apply manually in Supabase.
-- No existing business tables are modified by this migration.
-- This migration deliberately fails if any target object already exists;
-- inspect and reconcile it manually rather than accepting or replacing it.

do $$
begin
  if to_regclass('public.user_profiles') is not null then
    raise exception 'public.user_profiles already exists; inspect its schema and reconcile this migration manually';
  end if;

  if to_regprocedure('public.create_employee_profile()') is not null then
    raise exception 'public.create_employee_profile() already exists; inspect it before applying this migration';
  end if;

  if to_regprocedure('public.set_user_profile_role(uuid,text)') is not null then
    raise exception 'public.set_user_profile_role(uuid,text) already exists; inspect it before applying this migration';
  end if;

  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'on_auth_user_created_profile'
      and not tgisinternal
  ) then
    raise exception 'auth.users trigger on_auth_user_created_profile already exists; inspect it before applying this migration';
  end if;
end;
$$;

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'employee'
    check (role in ('employee', 'representative')),
  created_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

revoke all on table public.user_profiles from anon, authenticated;
grant select on table public.user_profiles to authenticated;

create policy "Users can read their own profile"
  on public.user_profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create function public.create_employee_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, role)
  values (new.id, 'employee')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_employee_profile()
  from public, anon, authenticated, supabase_auth_admin;

-- SECURITY DEFINER runs as postgres. The migration must be applied by postgres
-- (or a role allowed to transfer ownership to postgres).
alter function public.create_employee_profile() owner to postgres;

create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_employee_profile();

insert into public.user_profiles (id, role)
select id, 'employee'
from auth.users
on conflict (id) do nothing;

create function public.set_user_profile_role(
  target_user_id uuid,
  target_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_role is null
    or target_role not in ('employee', 'representative') then
    raise exception 'Unsupported user role';
  end if;

  update public.user_profiles
  set role = target_role
  where id = target_user_id;

  if not found then
    raise exception 'User profile not found';
  end if;
end;
$$;

revoke all on function public.set_user_profile_role(uuid, text)
  from public, anon, authenticated, service_role;

alter function public.set_user_profile_role(uuid, text) owner to postgres;

grant execute on function public.set_user_profile_role(uuid, text)
  to service_role;