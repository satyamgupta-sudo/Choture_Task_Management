-- Keep trigger helpers non-privileged and move the definer role check out of the
-- PostgREST-exposed public schema. The public wrapper is invoker-only.
create schema if not exists private;
revoke all on schema private from public,anon;
grant usage on schema private to authenticated;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='ADMIN' and active)
$$;
revoke all on function private.is_admin() from public,anon;
grant execute on function private.is_admin() to authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path=pg_catalog,private as $$
 select private.is_admin()
$$;
revoke all on function public.is_admin() from public,anon;
grant execute on function public.is_admin() to authenticated;

-- Only the Auth trigger should execute this profile provisioning function.
revoke all on function public.handle_new_user() from public,anon,authenticated;

-- These functions only copy values between NEW/OLD trigger records and need no
-- elevated database privileges. Invoker mode avoids exposing definer RPCs.
alter function public.sync_profile_active_aliases() security invoker;
alter function public.sync_notification_read_aliases() security invoker;
alter function public.sync_push_subscription_json() security invoker;
alter function public.sync_recurrence_schedule_aliases() security invoker;
revoke all on function public.sync_profile_active_aliases() from public,anon,authenticated;
revoke all on function public.sync_notification_read_aliases() from public,anon,authenticated;
revoke all on function public.sync_push_subscription_json() from public,anon,authenticated;
revoke all on function public.sync_recurrence_schedule_aliases() from public,anon,authenticated;

drop function if exists public.current_department_id();
