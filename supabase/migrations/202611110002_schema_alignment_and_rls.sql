-- Forward-only alignment for the existing restaurant-task-manager schema.
-- Keeps legacy columns used by the current client, while adding canonical fields
-- and append-only submission history. No rows or tables are dropped.

alter table public.departments add column if not exists description text not null default '';
alter table public.profiles add column if not exists is_active boolean not null default true;
alter table public.tasks add column if not exists created_by uuid references public.profiles(id);
update public.tasks set created_by=assigned_by where created_by is null;
alter table public.tasks alter column created_by set not null;

alter table public.task_assignments add column if not exists assigned_by uuid references public.profiles(id);
alter table public.task_assignments add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.task_assignments add column if not exists rejection_reason text;
update public.task_assignments a set assigned_by=t.assigned_by from public.tasks t where t.id=a.task_id and a.assigned_by is null;
alter table public.task_assignments alter column assigned_by set not null;
create index if not exists task_assignments_task_employee_idx on public.task_assignments(task_id,employee_id);

-- Keep one row per submission attempt. The previous unique assignment constraint
-- prevented rejected work from being resubmitted with history intact.
alter table public.submissions drop constraint if exists submissions_task_assignment_id_key;
alter table public.submissions add column if not exists assignment_id uuid references public.task_assignments(id) on delete cascade;
alter table public.submissions add column if not exists employee_id uuid references public.profiles(id) on delete cascade;
alter table public.submissions add column if not exists checkbox_value boolean;
alter table public.submissions add column if not exists text_value text;
alter table public.submissions add column if not exists photo_storage_path text;
alter table public.submissions add column if not exists version integer not null default 1;
update public.submissions s set assignment_id=s.task_assignment_id,employee_id=a.employee_id,checkbox_value=s.checkbox_confirmed,text_value=s.response_text,photo_storage_path=s.evidence_path from public.task_assignments a where a.id=s.task_assignment_id;
alter table public.submissions alter column assignment_id set not null;
alter table public.submissions alter column employee_id set not null;
alter table public.submissions add constraint submissions_version_positive check(version>0);
create index if not exists submissions_assignment_history_idx on public.submissions(assignment_id,version desc);
create unique index if not exists submissions_assignment_version_key on public.submissions(assignment_id,version);

alter table public.notifications add column if not exists recipient_id uuid references public.profiles(id) on delete cascade;
alter table public.notifications add column if not exists message text;
alter table public.notifications add column if not exists notification_type text not null default 'TASK_UPDATE';
alter table public.notifications add column if not exists related_assignment_id uuid references public.task_assignments(id) on delete cascade;
alter table public.notifications add column if not exists is_read boolean not null default false;
update public.notifications set recipient_id=user_id,message=body,is_read=(read_at is not null) where recipient_id is null or message is null;
alter table public.notifications alter column recipient_id set not null;
alter table public.notifications alter column message set not null;
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_id,created_at desc);

alter table public.task_recurrences add column if not exists is_active boolean not null default true;
alter table public.task_recurrences add column if not exists scheduled_time time;
alter table public.task_recurrences add column if not exists last_generated_at timestamptz;
update public.task_recurrences set is_active=active,scheduled_time=local_time,last_generated_at=case when last_generated_date is null then null else last_generated_date::timestamptz end;
alter table public.task_recurrences alter column scheduled_time set not null;
create or replace function public.sync_recurrence_schedule_aliases() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
  new.active:=new.is_active;
  new.local_time:=coalesce(new.scheduled_time,new.local_time);
  new.scheduled_time:=new.local_time;
  if new.last_generated_at is not null then new.last_generated_date:=new.last_generated_at::date; end if;
  return new;
 end if;
 if new.active is distinct from old.active then new.is_active:=new.active; else new.active:=new.is_active; end if;
 if new.local_time is distinct from old.local_time then new.scheduled_time:=new.local_time; else new.local_time:=new.scheduled_time; end if;
 if new.last_generated_date is distinct from old.last_generated_date then new.last_generated_at:=new.last_generated_date::timestamptz; else new.last_generated_date:=new.last_generated_at::date; end if;
 return new;
end $$;
drop trigger if exists task_recurrences_sync_aliases on public.task_recurrences;
create trigger task_recurrences_sync_aliases before insert or update of active,is_active,local_time,scheduled_time,last_generated_date,last_generated_at on public.task_recurrences for each row execute function public.sync_recurrence_schedule_aliases();
alter table public.push_subscriptions add column if not exists subscription_json jsonb;
update public.push_subscriptions set subscription_json=jsonb_build_object('token',token) where subscription_json is null;
alter table public.push_subscriptions alter column subscription_json set not null;
create or replace function public.sync_push_subscription_json() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.subscription_json is null then new.subscription_json:=jsonb_build_object('token',new.token);
 elsif new.token is null then new.token:=new.subscription_json->>'token'; end if;
 new.updated_at:=now();
 return new;
end $$;
drop trigger if exists push_subscriptions_sync_json on public.push_subscriptions;
create trigger push_subscriptions_sync_json before insert or update of token,subscription_json on public.push_subscriptions for each row execute function public.sync_push_subscription_json();
alter table public.audit_logs add column if not exists metadata jsonb not null default '{}'::jsonb;
update public.audit_logs set metadata=details where metadata='{}'::jsonb and details is not null;

create or replace function public.sync_profile_active_aliases() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then new.active:=new.is_active; return new; end if;
 if new.active is distinct from old.active then new.is_active:=new.active; else new.active:=new.is_active; end if;
 return new;
end $$;
drop trigger if exists profiles_sync_active_aliases on public.profiles;
create trigger profiles_sync_active_aliases before insert or update of active,is_active on public.profiles for each row execute function public.sync_profile_active_aliases();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.profiles(id,full_name,role,active,is_active)
 values(new.id,coalesce(new.raw_user_meta_data->>'full_name','Restaurant team member'),'EMPLOYEE',true,true);
 return new;
end $$;
revoke all on function public.handle_new_user() from public,anon,authenticated;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='ADMIN' and active)
$$;
create or replace function public.current_department_id() returns uuid
language sql stable security definer set search_path=pg_catalog,public as $$
 select department_id from public.profiles where id=auth.uid()
$$;

create or replace function public.sync_notification_read_aliases() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.read_at is distinct from old.read_at then new.is_read:=(new.read_at is not null); else new.read_at:=case when new.is_read then coalesce(old.read_at,now()) else null end; end if;
 return new;
end $$;
drop trigger if exists notifications_sync_read_aliases on public.notifications;
create trigger notifications_sync_read_aliases before update of read_at,is_read on public.notifications for each row execute function public.sync_notification_read_aliases();

-- A department task always fans out to every active employee in that department.
-- Individual assignments are accepted only when p_department_id is null.
drop function if exists public.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]);
create function public.create_task_with_assignments(p_title text,p_description text,p_priority public.task_priority,p_due_at timestamptz,p_submission_type public.submission_kind,p_department_id uuid,p_assignee_ids uuid[]) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare tid uuid; eligible_count integer;
begin
 if not public.is_admin() then raise exception 'Only administrators can assign tasks'; end if;
 if length(trim(coalesce(p_title,''))) not between 1 and 120 then raise exception 'Task title must be 1 to 120 characters'; end if;
 if p_department_id is not null then
  if not exists(select 1 from public.departments where id=p_department_id) then raise exception 'Department not found'; end if;
  select count(*) into eligible_count from public.profiles where department_id=p_department_id and active and role='EMPLOYEE';
  if eligible_count=0 then raise exception 'Department has no active employees'; end if;
 else
  if coalesce(array_length(p_assignee_ids,1),0)=0 then raise exception 'Choose at least one active employee'; end if;
  if exists(select 1 from unnest(p_assignee_ids) x left join public.profiles p on p.id=x where p.id is null or not p.active or p.role<>'EMPLOYEE') then raise exception 'Assignees must be active employees'; end if;
 end if;
 insert into public.tasks(title,description,department_id,assigned_by,created_by,priority,due_at,submission_type)
 values(trim(p_title),coalesce(p_description,''),p_department_id,auth.uid(),auth.uid(),p_priority,p_due_at,p_submission_type) returning id into tid;
 insert into public.task_assignments(task_id,employee_id,department_id,assigned_by)
 select tid,p.id,p.department_id,auth.uid() from public.profiles p
 where p.active and p.role='EMPLOYEE' and ((p_department_id is not null and p.department_id=p_department_id) or (p_department_id is null and p.id=any(p_assignee_ids)))
 on conflict(task_id,employee_id) do nothing;
 insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id)
 select p.id,p.id,'New task assigned',trim(p_title),trim(p_title),'TASK_ASSIGNED','task',tid from public.profiles p
 join public.task_assignments a on a.task_id=tid and a.employee_id=p.id;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(auth.uid(),'task',tid,'created',jsonb_build_object('department_id',p_department_id,'assignees',p_assignee_ids),jsonb_build_object('department_id',p_department_id,'assignees',p_assignee_ids));
 return tid;
end $$;

create or replace function public.submit_task(p_assignment_id uuid,p_response_text text,p_evidence_path text,p_checkbox_confirmed boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.task_assignments; t public.tasks; next_version integer;
begin
 select * into a from public.task_assignments where id=p_assignment_id for update;
 if not found then raise exception 'Assignment not found'; end if;
 if a.employee_id<>auth.uid() then raise exception 'You can only submit your own work'; end if;
 select * into t from public.tasks where id=a.task_id;
 if a.status not in ('IN_PROGRESS','REJECTED') then raise exception 'This task cannot be submitted in its current state'; end if;
 if t.submission_type='TEXT' and length(trim(coalesce(p_response_text,'')))=0 then raise exception 'A written response is required'; end if;
 if t.submission_type='CAMERA' and (p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/'||p_assignment_id::text||'/%' or not exists(select 1 from storage.objects o where o.bucket_id='task-evidence' and o.name=p_evidence_path and o.metadata->>'mimetype'='image/jpeg')) then raise exception 'A camera photo is required'; end if;
 if t.submission_type='CHECKBOX' and not coalesce(p_checkbox_confirmed,false) then raise exception 'Confirm task completion before submitting'; end if;
 select coalesce(max(s.version),0)+1 into next_version from public.submissions s where s.assignment_id=p_assignment_id;
 insert into public.submissions(task_assignment_id,assignment_id,employee_id,response_text,evidence_path,checkbox_confirmed,submitted_at,review_comment,reviewed_by,checkbox_value,text_value,photo_storage_path,version)
 values(p_assignment_id,p_assignment_id,a.employee_id,nullif(trim(p_response_text),''),p_evidence_path,coalesce(p_checkbox_confirmed,false),now(),null,null,case when t.submission_type='CHECKBOX' then p_checkbox_confirmed else null end,nullif(trim(p_response_text),''),p_evidence_path,next_version);
 update public.task_assignments set status='PENDING_APPROVAL',submitted_at=now(),reviewed_at=null,reviewed_by=null,rejection_reason=null,completed_at=null where id=p_assignment_id;
 insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
 select id,id,'Task submitted for review',t.title,t.title,'SUBMITTED','assignment',p_assignment_id,p_assignment_id from public.profiles where role='ADMIN' and active;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(auth.uid(),'assignment',p_assignment_id,'submitted',jsonb_build_object('version',next_version),jsonb_build_object('version',next_version));
end $$;

create or replace function public.review_task(p_assignment_id uuid,p_decision text,p_comment text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.task_assignments; t public.tasks; latest_submission uuid;
begin
 if not public.is_admin() then raise exception 'Only administrators can review tasks'; end if;
 if p_decision not in ('approve','reject') then raise exception 'Invalid review decision'; end if;
 if p_decision='reject' and length(trim(coalesce(p_comment,'')))=0 then raise exception 'Feedback is required when returning a task'; end if;
 select * into a from public.task_assignments where id=p_assignment_id for update;
 if not found or a.status not in ('PENDING_APPROVAL','SUBMITTED') then raise exception 'This submission is not awaiting review'; end if;
 if a.employee_id=auth.uid() then raise exception 'An administrator cannot review their own assignment'; end if;
 select * into t from public.tasks where id=a.task_id;
 select id into latest_submission from public.submissions where assignment_id=p_assignment_id order by version desc limit 1;
 if latest_submission is null then raise exception 'Submission record not found'; end if;
 update public.task_assignments set status=case when p_decision='approve' then 'COMPLETED'::public.task_status else 'REJECTED'::public.task_status end,
 reviewed_at=now(),reviewed_by=auth.uid(),completed_at=case when p_decision='approve' then now() else null end,rejection_reason=case when p_decision='reject' then trim(p_comment) else null end where id=p_assignment_id;
 update public.submissions set review_comment=nullif(trim(p_comment),''),reviewed_by=auth.uid() where id=latest_submission;
 insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
 values(a.employee_id,a.employee_id,case when p_decision='approve' then 'Task approved' else 'Task returned for another try' end,t.title||case when p_decision='reject' then ': '||trim(p_comment) else '' end,t.title||case when p_decision='reject' then ': '||trim(p_comment) else '' end,case when p_decision='approve' then 'APPROVED' else 'REJECTED' end,'assignment',p_assignment_id,p_assignment_id);
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(auth.uid(),'assignment',p_assignment_id,p_decision,jsonb_build_object('comment',p_comment,'submission_id',latest_submission),jsonb_build_object('comment',p_comment,'submission_id',latest_submission));
end $$;

create or replace function public.advance_task(p_assignment_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.task_assignments set status='IN_PROGRESS',started_at=now() where id=p_assignment_id and employee_id=auth.uid() and status='ASSIGNED';
 if not found then raise exception 'Task cannot be started'; end if;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata) values(auth.uid(),'assignment',p_assignment_id,'started','{}'::jsonb,'{}'::jsonb);
end $$;

-- Revoke the default PUBLIC execute grant on every privileged RPC. Only signed-in
-- users may invoke them; each function performs its own role/ownership checks.
revoke all on function public.is_admin() from public,anon;
revoke all on function public.current_department_id() from public,anon;
revoke all on function public.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) from public,anon;
revoke all on function public.submit_task(uuid,text,text,boolean) from public,anon;
revoke all on function public.review_task(uuid,text,text) from public,anon;
revoke all on function public.advance_task(uuid) from public,anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_department_id() to authenticated;
grant execute on function public.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) to authenticated;
grant execute on function public.submit_task(uuid,text,text,boolean) to authenticated;
grant execute on function public.review_task(uuid,text,text) to authenticated;
grant execute on function public.advance_task(uuid) to authenticated;

-- Replace permissive/legacy policies with least-privilege policies. Writes to
-- assignments and submissions happen only through checked SECURITY DEFINER RPCs.
drop policy if exists "profiles visible to team" on public.profiles;
drop policy if exists "admins manage profiles" on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "departments readable" on public.departments;
drop policy if exists "admins manage departments" on public.departments;
create policy departments_read_authenticated on public.departments for select to authenticated using(true);
create policy departments_admin_write on public.departments for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "tasks visible to assigned staff" on public.tasks;
drop policy if exists "admins edit tasks" on public.tasks;
create policy tasks_read_assigned_or_admin on public.tasks for select to authenticated using(public.is_admin() or exists(select 1 from public.task_assignments a where a.task_id=public.tasks.id and a.employee_id=auth.uid()));
create policy tasks_admin_update on public.tasks for update to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "assignments visible to owner or admin" on public.task_assignments;
create policy assignments_read_owner_or_admin on public.task_assignments for select to authenticated using(employee_id=auth.uid() or public.is_admin());

drop policy if exists "submissions visible to owner or admin" on public.submissions;
create policy submissions_read_owner_or_admin on public.submissions for select to authenticated using(public.is_admin() or employee_id=auth.uid());

drop policy if exists "notifications private" on public.notifications;
drop policy if exists "user marks notification read" on public.notifications;
create policy notifications_read_recipient on public.notifications for select to authenticated using(recipient_id=auth.uid());
create policy notifications_update_own_read_state on public.notifications for update to authenticated using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
revoke update on public.notifications from authenticated;
grant update(read_at,is_read) on public.notifications to authenticated;

drop policy if exists "push subscriptions private" on public.push_subscriptions;
create policy push_subscriptions_owner_only on public.push_subscriptions for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

drop policy if exists "templates admin only" on public.task_templates;
drop policy if exists "recurrences admin only" on public.task_recurrences;
create policy templates_admin_only on public.task_templates for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy recurrences_admin_only on public.task_recurrences for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "audit visible to admin or actor" on public.audit_logs;
create policy audit_admin_read_only on public.audit_logs for select to authenticated using(public.is_admin());

alter table public.profiles enable row level security;
alter table public.departments enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignments enable row level security;
alter table public.submissions enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.task_templates enable row level security;
alter table public.task_recurrences enable row level security;
alter table public.audit_logs enable row level security;

-- Camera uploads must be JPEGs placed under {employee_id}/{assignment_id}/...;
-- the employee must own an active camera assignment. No public read policy exists.
drop policy if exists "employees upload own evidence" on storage.objects;
drop policy if exists "evidence readable by assignee and admins" on storage.objects;
drop policy if exists "employees remove own evidence" on storage.objects;
create policy task_evidence_upload_own_camera_assignment on storage.objects for insert to authenticated
 with check(bucket_id='task-evidence' and (storage.foldername(name))[1]=auth.uid()::text and exists(
  select 1 from public.task_assignments a join public.tasks t on t.id=a.task_id
  where a.id=((storage.foldername(name))[2])::uuid and a.employee_id=auth.uid() and t.submission_type='CAMERA' and a.status in ('IN_PROGRESS','REJECTED')));
create policy task_evidence_read_owner_or_admin on storage.objects for select to authenticated
 using(bucket_id='task-evidence' and (public.is_admin() or (storage.foldername(name))[1]=auth.uid()::text));
create policy task_evidence_delete_owner_or_admin on storage.objects for delete to authenticated
 using(bucket_id='task-evidence' and (public.is_admin() or (storage.foldername(name))[1]=auth.uid()::text));

-- Enforce private bucket settings even when it was created outside this migration.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('task-evidence','task-evidence',false,5242880,array['image/jpeg']) on conflict(id) do update
 set public=false,file_size_limit=least(storage.buckets.file_size_limit,5242880),allowed_mime_types=array['image/jpeg'];
