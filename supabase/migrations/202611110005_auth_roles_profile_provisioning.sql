-- Secure initial administrator bootstrap and audited profile/role management.
-- Auth signup always creates EMPLOYEE; only the database owner can bootstrap
-- the first ADMIN. Later role changes use checked private RPC implementations.

create or replace function private.bootstrap_initial_admin(p_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,auth,private as $$
declare target_id uuid; admin_count integer;
begin
 if auth.uid() is not null then raise exception 'Initial admin bootstrap must be run by the database owner'; end if;
 select count(*) into admin_count from public.profiles where role='ADMIN' and active;
 if admin_count>0 then raise exception 'An active administrator already exists'; end if;
 select p.id into target_id from auth.users u join public.profiles p on p.id=u.id
 where lower(u.email)=lower(trim(p_email)) and p.active and p.role='EMPLOYEE';
 if target_id is null then raise exception 'No active employee profile matches that Auth email'; end if;
 update public.profiles set role='ADMIN',updated_at=now() where id=target_id;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(null,'profile',target_id,'initial_admin_bootstrap','{}'::jsonb,jsonb_build_object('method','database_owner_bootstrap'));
 return target_id;
end $$;
revoke all on function private.bootstrap_initial_admin(text) from public,anon,authenticated,service_role;

create or replace function private.manage_profile(p_profile_id uuid,p_full_name text,p_department_id uuid,p_is_active boolean,p_role public.app_role) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare target public.profiles; active_admins integer;
begin
 if not private.is_admin() then raise exception 'Only administrators can manage team profiles'; end if;
 if p_profile_id=auth.uid() and (p_role is distinct from (select role from public.profiles where id=auth.uid()) or p_is_active is distinct from true) then
  raise exception 'You cannot change your own role or deactivate your own account';
 end if;
 select * into target from public.profiles where id=p_profile_id for update;
 if not found then raise exception 'Profile not found'; end if;
 if length(trim(coalesce(p_full_name,''))) not between 1 and 120 then raise exception 'Name must be 1 to 120 characters'; end if;
 if p_department_id is not null and not exists(select 1 from public.departments where id=p_department_id) then raise exception 'Department not found'; end if;
 if target.role='ADMIN' and target.active and (p_role<>'ADMIN' or not p_is_active) then
  select count(*) into active_admins from public.profiles where role='ADMIN' and active and id<>p_profile_id;
  if active_admins=0 then raise exception 'The restaurant must keep at least one active administrator'; end if;
 end if;
 if p_role='ADMIN' and not p_is_active then raise exception 'An administrator profile must remain active'; end if;
 update public.profiles set full_name=trim(p_full_name),department_id=p_department_id,active=p_is_active,is_active=p_is_active,role=p_role,updated_at=now() where id=p_profile_id;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(auth.uid(),'profile',p_profile_id,'profile_updated',jsonb_build_object('role_before',target.role,'role_after',p_role,'active_before',target.active,'active_after',p_is_active),jsonb_build_object('department_id',p_department_id));
end $$;
revoke all on function private.manage_profile(uuid,text,uuid,boolean,public.app_role) from public,anon;
grant execute on function private.manage_profile(uuid,text,uuid,boolean,public.app_role) to authenticated;

create or replace function private.enforce_assignment_transitions() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,private as $$
begin
 if new.status is not distinct from old.status then return new; end if;
 if new.status='IN_PROGRESS' and old.status='ASSIGNED' then
  if new.employee_id<>auth.uid() or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE') then raise exception 'Only the active assignee can start this task'; end if;
 elsif new.status='PENDING_APPROVAL' and old.status in ('IN_PROGRESS','REJECTED') then
  if new.employee_id<>auth.uid() or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE') then raise exception 'Only the active assignee can submit this task'; end if;
 elsif new.status in ('COMPLETED','REJECTED') and old.status in ('PENDING_APPROVAL','SUBMITTED') then
  if not private.is_admin() or new.employee_id=auth.uid() then raise exception 'Only another active administrator can review this task'; end if;
 else
  raise exception 'Invalid task status transition';
 end if;
 return new;
end $$;
revoke all on function private.enforce_assignment_transitions() from public,anon,authenticated;
drop trigger if exists task_assignment_enforce_transitions on public.task_assignments;
create trigger task_assignment_enforce_transitions before update of status on public.task_assignments for each row execute function private.enforce_assignment_transitions();

create or replace function public.manage_profile(p_profile_id uuid,p_full_name text,p_department_id uuid,p_is_active boolean,p_role public.app_role) returns void
language sql security invoker set search_path=pg_catalog,public,private as $$
 select private.manage_profile($1,$2,$3,$4,$5)
$$;
revoke all on function public.manage_profile(uuid,text,uuid,boolean,public.app_role) from public,anon;
grant execute on function public.manage_profile(uuid,text,uuid,boolean,public.app_role) to authenticated;

-- Prevent direct profile writes from changing a role or bypassing the audited RPC.
drop policy if exists profiles_admin_update on public.profiles;
revoke update on public.profiles from authenticated;

-- Disabled accounts retain access to their own profile for a clear sign-in
-- message, but cannot read assignments, submissions, task data or notifications.
drop policy if exists assignments_read_owner_or_admin on public.task_assignments;
create policy assignments_read_owner_or_admin on public.task_assignments for select to authenticated
 using(public.is_admin() or (employee_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE')));
drop policy if exists submissions_read_owner_or_admin on public.submissions;
create policy submissions_read_owner_or_admin on public.submissions for select to authenticated
 using(public.is_admin() or (employee_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE')));
drop policy if exists tasks_read_assigned_or_admin on public.tasks;
create policy tasks_read_assigned_or_admin on public.tasks for select to authenticated
 using(public.is_admin() or exists(select 1 from public.task_assignments a join public.profiles p on p.id=a.employee_id where a.task_id=public.tasks.id and a.employee_id=auth.uid() and p.active and p.role='EMPLOYEE'));
drop policy if exists notifications_read_recipient on public.notifications;
create policy notifications_read_recipient on public.notifications for select to authenticated
 using(recipient_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active));
drop policy if exists notifications_update_own_read_state on public.notifications;
create policy notifications_update_own_read_state on public.notifications for update to authenticated
 using(recipient_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active))
 with check(recipient_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active));

-- Role and department selection cannot be changed with a raw PostgREST update.
revoke all on function private.manage_profile(uuid,text,uuid,boolean,public.app_role) from public,anon;
grant execute on function private.manage_profile(uuid,text,uuid,boolean,public.app_role) to authenticated;
