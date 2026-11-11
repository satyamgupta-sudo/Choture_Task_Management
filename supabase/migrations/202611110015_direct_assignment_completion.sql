-- Employees can submit an assigned task directly. Starting the task is no
-- longer a separate user action; the checked submit RPC records started_at
-- and moves the assignment straight to PENDING_APPROVAL.
create or replace function private.enforce_assignment_transitions()
returns trigger
language plpgsql
security invoker
set search_path=pg_catalog,public,private
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status='IN_PROGRESS' and old.status='ASSIGNED' then
    if new.employee_id<>auth.uid() or not exists(
      select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE'
    ) then raise exception 'Only the active assignee can start this task'; end if;
  elsif new.status='PENDING_APPROVAL' and old.status in ('ASSIGNED','IN_PROGRESS','REJECTED') then
    if new.employee_id<>auth.uid() or not exists(
      select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE'
    ) then raise exception 'Only the active assignee can submit this task'; end if;
  elsif new.status in ('COMPLETED','REJECTED') and old.status in ('PENDING_APPROVAL','SUBMITTED') then
    if not private.is_admin() or new.employee_id=auth.uid() then
      raise exception 'Only another active administrator can review this task';
    end if;
  else
    raise exception 'Invalid task status transition';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_assignment_transitions() from public,anon,authenticated;

create or replace function private.submit_user_first_task(
  p_assignment_id uuid,
  p_response_text text,
  p_checkbox_confirmed boolean,
  p_checklist_values jsonb,
  p_evidence_path text
) returns void
language plpgsql
security definer
set search_path=pg_catalog,public,private,auth
as $$
declare
  a public.task_assignments;
  t public.tasks;
  v_version integer;
  v_item jsonb;
  v_item_id text;
  v_photo_required boolean;
  v_submitted_at timestamptz:=statement_timestamp();
begin
  select * into a from public.task_assignments where id=p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  if a.employee_id<>auth.uid() or not exists(
    select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE'
  ) then raise exception 'You can only submit your own active assignment'; end if;
  select * into t from public.tasks where id=a.task_id and archived_at is null;
  if not found then raise exception 'Task not found or archived'; end if;
  if a.status not in ('ASSIGNED','IN_PROGRESS','REJECTED') then
    raise exception 'This task cannot be submitted in its current state';
  end if;
  if jsonb_typeof(coalesce(p_checklist_values,'{}'::jsonb))<>'object' then
    raise exception 'Checklist values must be an object';
  end if;
  for v_item in select value from jsonb_array_elements(
    case when jsonb_typeof(t.submission_config->'checklist_items')='array'
      then t.submission_config->'checklist_items' else '[]'::jsonb end
  ) loop
    v_item_id:=v_item->>'id';
    if coalesce((p_checklist_values->>v_item_id)::boolean,false) is not true then
      raise exception 'Complete every checklist item before submitting';
    end if;
  end loop;
  if t.submission_type='CHECKBOX'
    and coalesce(jsonb_array_length(t.submission_config->'checklist_items'),0)=0
    and not coalesce(p_checkbox_confirmed,false) then
    raise exception 'Confirm task completion before submitting';
  end if;
  if t.submission_type in ('TEXT','MULTIPLE') and length(trim(coalesce(p_response_text,'')))=0 then
    raise exception 'A written response is required';
  end if;
  v_photo_required:=t.submission_type in ('CAMERA','MULTIPLE');
  if v_photo_required and (
    p_evidence_path is null
    or p_evidence_path not like auth.uid()::text||'/'||p_assignment_id::text||'/%'
    or not exists(select 1 from storage.objects o where o.bucket_id='task-evidence'
      and o.name=p_evidence_path and o.metadata->>'mimetype'='image/jpeg')
  ) then raise exception 'A camera photo is required'; end if;
  if not v_photo_required and p_evidence_path is not null then
    raise exception 'This task does not accept photo evidence';
  end if;

  select coalesce(max(s.version),0)+1 into v_version
  from public.submissions s where s.assignment_id=p_assignment_id;
  insert into public.submissions(
    task_assignment_id,assignment_id,employee_id,response_text,evidence_path,
    checkbox_confirmed,checkbox_value,text_value,photo_storage_path,checklist_values,
    submitted_at,review_comment,reviewed_by,version
  ) values(
    p_assignment_id,p_assignment_id,a.employee_id,nullif(trim(p_response_text),''),p_evidence_path,
    coalesce(p_checkbox_confirmed,false),
    case when t.submission_type in ('CHECKBOX','MULTIPLE') then true else null end,
    nullif(trim(p_response_text),''),p_evidence_path,coalesce(p_checklist_values,'{}'::jsonb),
    v_submitted_at,null,null,v_version
  );
  update public.task_assignments
  set status='PENDING_APPROVAL',started_at=coalesce(started_at,v_submitted_at),
      submitted_at=v_submitted_at,reviewed_at=null,reviewed_by=null,
      rejection_reason=null,completed_at=null
  where id=p_assignment_id;
  insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
    select p.id,p.id,'Task submitted for review',t.title,t.title,'SUBMITTED','assignment',p_assignment_id,p_assignment_id
    from public.profiles p where p.role='ADMIN' and p.active;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
    values(auth.uid(),'assignment',p_assignment_id,'submitted',
      jsonb_build_object('version',v_version),jsonb_build_object('version',v_version));
end
$$;
revoke all on function private.submit_user_first_task(uuid,text,boolean,jsonb,text) from public,anon;
grant execute on function private.submit_user_first_task(uuid,text,boolean,jsonb,text) to authenticated;

-- Public wrapper remains invoker-only; all authorization and validation stays
-- inside the private implementation.
create or replace function public.submit_user_first_task(
  p_assignment_id uuid,p_response_text text,p_checkbox_confirmed boolean,
  p_checklist_values jsonb,p_evidence_path text
) returns void
language sql
security invoker
set search_path=pg_catalog,public,private
as $$ select private.submit_user_first_task($1,$2,$3,$4,$5) $$;
revoke all on function public.submit_user_first_task(uuid,text,boolean,jsonb,text) from public,anon;
grant execute on function public.submit_user_first_task(uuid,text,boolean,jsonb,text) to authenticated;

-- Camera evidence can be captured for an assigned task without a separate
-- start transition. The path remains bound to the active owner and assignment.
drop policy if exists task_evidence_upload_own_camera_assignment on storage.objects;
create policy task_evidence_upload_own_camera_assignment on storage.objects
for insert to authenticated
with check (
  bucket_id='task-evidence'
  and (storage.foldername(name))[1]=auth.uid()::text
  and exists (
    select 1
    from public.task_assignments a
    join public.tasks t on t.id=a.task_id
    join public.profiles p on p.id=a.employee_id
    where a.id=((storage.foldername(name))[2])::uuid
      and a.employee_id=auth.uid()
      and p.active and p.role='EMPLOYEE'
      and t.submission_type in ('CAMERA','MULTIPLE')
      and a.status in ('ASSIGNED','IN_PROGRESS','REJECTED')
  )
);
