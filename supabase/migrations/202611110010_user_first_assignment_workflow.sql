-- Extend the existing task/submission/recurrence tables; no rows are removed.
alter table public.tasks
  add column if not exists submission_config jsonb not null default '{}'::jsonb,
  add column if not exists recurrence_id uuid references public.task_recurrences(id) on delete set null,
  add column if not exists recurrence_date date;
alter table public.submissions
  add column if not exists checklist_values jsonb not null default '{}'::jsonb;
alter table public.task_recurrences
  add column if not exists submission_config jsonb not null default '{}'::jsonb;

create unique index if not exists tasks_recurrence_instance_unique
  on public.tasks(recurrence_id,recurrence_date)
  where recurrence_id is not null and recurrence_date is not null;
create index if not exists task_recurrences_active_start_idx
  on public.task_recurrences(start_date)
  where active;

-- Recurring instances are generated from the scheduled service; their due time
-- may be only a few minutes ahead when a scheduler invocation is delayed.
create or replace function private.validate_new_task_input()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if length(trim(coalesce(new.title,''))) not between 1 and 120 then raise exception 'Task title must be 1 to 120 characters'; end if;
  if length(coalesce(new.description,''))>2000 then raise exception 'Task instructions must be 2000 characters or fewer'; end if;
  if new.due_at is not null and new.due_at<=statement_timestamp() and new.recurrence_id is null then raise exception 'Task deadline must be in the future'; end if;
  return new;
end
$$;

drop policy if exists task_evidence_upload_own_camera_assignment on storage.objects;
create policy task_evidence_upload_own_camera_assignment on storage.objects for insert to authenticated
 with check(bucket_id='task-evidence' and (storage.foldername(name))[1]=auth.uid()::text and exists(
  select 1 from public.task_assignments a join public.tasks t on t.id=a.task_id
  where a.id=((storage.foldername(name))[2])::uuid and a.employee_id=auth.uid() and t.submission_type in ('CAMERA','MULTIPLE') and a.status in ('IN_PROGRESS','REJECTED')));

create or replace function private.create_user_first_task(
  p_title text,
  p_description text,
  p_priority public.task_priority,
  p_due_at timestamptz,
  p_submission_type public.submission_kind,
  p_submission_config jsonb,
  p_assignee_ids uuid[],
  p_recurrence_frequency text,
  p_recurrence_start_date date,
  p_recurrence_end_date date,
  p_timezone text,
  p_scheduled_time time
) returns uuid
language plpgsql security definer
set search_path=pg_catalog,public,private,auth
as $$
declare
  v_task_id uuid;
  v_recurrence_id uuid;
  v_config jsonb:=coalesce(p_submission_config,'{}'::jsonb);
  v_frequency text:=nullif(upper(trim(coalesce(p_recurrence_frequency,''))),'ONCE');
  v_department_id uuid;
begin
  if not private.is_admin() then raise exception 'Only active administrators can assign tasks'; end if;
  if length(trim(coalesce(p_title,''))) not between 1 and 120 then raise exception 'Task title must be 1 to 120 characters'; end if;
  if length(coalesce(p_description,''))>2000 then raise exception 'Task instructions must be 2000 characters or fewer'; end if;
  if p_due_at is not null and p_due_at<=statement_timestamp() then raise exception 'Task deadline must be in the future'; end if;
  if coalesce(cardinality(p_assignee_ids),0)=0 then raise exception 'Select at least one employee'; end if;
  if cardinality(p_assignee_ids)<>(select count(distinct x) from unnest(p_assignee_ids) x) then raise exception 'Remove duplicate employees from the selection'; end if;
  if exists(select 1 from unnest(p_assignee_ids) x left join public.profiles p on p.id=x where p.id is null or not p.active or p.role<>'EMPLOYEE') then
    raise exception 'Every selected assignee must be an active employee';
  end if;
  if jsonb_typeof(v_config)<>'object' then raise exception 'Submission configuration must be an object'; end if;
  if v_config ? 'checklist_items' and jsonb_typeof(v_config->'checklist_items')<>'array' then raise exception 'Checklist items must be an array'; end if;
  if coalesce(jsonb_array_length(case when jsonb_typeof(v_config->'checklist_items')='array' then v_config->'checklist_items' else '[]'::jsonb end),0)>30 then raise exception 'A task can have at most 30 checklist items'; end if;
  if length(coalesce(v_config->>'photo_instructions',''))>1000 then raise exception 'Photo instructions must be 1000 characters or fewer'; end if;
  if p_submission_type='MULTIPLE' and coalesce(jsonb_array_length(case when jsonb_typeof(v_config->'checklist_items')='array' then v_config->'checklist_items' else '[]'::jsonb end),0)=0 then raise exception 'Multiple submissions require at least one checklist item'; end if;
  if exists(select 1 from jsonb_array_elements(case when jsonb_typeof(v_config->'checklist_items')='array' then v_config->'checklist_items' else '[]'::jsonb end) item where length(trim(coalesce(item->>'id','')))=0 or length(trim(coalesce(item->>'text','')))=0) then
    raise exception 'Each checklist item requires an id and description';
  end if;

  if v_frequency is not null then
    if v_frequency not in ('DAILY','WEEKLY','MONTHLY') then raise exception 'Choose Once, Daily, Weekly, or Monthly recurrence'; end if;
    if p_recurrence_start_date is null or p_scheduled_time is null then raise exception 'Recurring tasks require a start date and scheduled time'; end if;
    if p_recurrence_end_date is not null and p_recurrence_end_date<p_recurrence_start_date then raise exception 'Recurrence end date must be on or after its start date'; end if;
    if not exists(select 1 from pg_catalog.pg_timezone_names where name=coalesce(nullif(p_timezone,''),'UTC')) then raise exception 'Choose a valid time zone'; end if;
    insert into public.task_recurrences(template_id,created_by,title,description,priority,submission_type,assignee_ids,frequency,local_time,scheduled_time,start_date,end_date,timezone,active,is_active,submission_config)
    values(null,auth.uid(),trim(p_title),coalesce(p_description,''),p_priority,p_submission_type,p_assignee_ids,v_frequency,p_scheduled_time,p_scheduled_time,p_recurrence_start_date,p_recurrence_end_date,coalesce(nullif(p_timezone,''),'UTC'),true,true,v_config)
    returning id into v_recurrence_id;
  end if;

  select case when count(*) filter(where department_id is null)=0 and count(distinct department_id)=1 then (array_agg(distinct department_id))[1] else null end into v_department_id
    from public.profiles where id=any(p_assignee_ids);
  insert into public.tasks(title,description,department_id,assigned_by,created_by,priority,due_at,submission_type,submission_config,recurrence_id,recurrence_date,recurrence_rule)
  values(trim(p_title),coalesce(p_description,''),v_department_id,auth.uid(),auth.uid(),p_priority,p_due_at,p_submission_type,v_config,v_recurrence_id,case when v_recurrence_id is not null then p_recurrence_start_date else null end,
         case when v_recurrence_id is not null then jsonb_build_object('id',v_recurrence_id,'date',p_recurrence_start_date) else null end)
  returning id into v_task_id;

  insert into public.task_assignments(task_id,employee_id,department_id,assigned_by,instance_date)
  select v_task_id,p.id,p.department_id,auth.uid(),case when v_recurrence_id is not null then p_recurrence_start_date else null end
  from public.profiles p where p.id=any(p_assignee_ids) and p.active and p.role='EMPLOYEE';

  insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
  select a.employee_id,a.employee_id,'New task assigned',trim(p_title),trim(p_title),'TASK_ASSIGNED','assignment',a.id,a.id
  from public.task_assignments a where a.task_id=v_task_id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
  values(auth.uid(),'task',v_task_id,'created',jsonb_build_object('assignees',p_assignee_ids,'recurrence_id',v_recurrence_id),jsonb_build_object('assignees',p_assignee_ids,'submission_type',p_submission_type,'recurrence_id',v_recurrence_id));
  return v_task_id;
end
$$;

create or replace function public.create_user_first_task(
  p_title text,p_description text,p_priority public.task_priority,p_due_at timestamptz,
  p_submission_type public.submission_kind,p_submission_config jsonb,p_assignee_ids uuid[],
  p_recurrence_frequency text,p_recurrence_start_date date,p_recurrence_end_date date,
  p_timezone text,p_scheduled_time time
) returns uuid language sql security invoker
set search_path=pg_catalog,public,private as $$
  select private.create_user_first_task($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
$$;
revoke all on function private.create_user_first_task(text,text,public.task_priority,timestamptz,public.submission_kind,jsonb,uuid[],text,date,date,text,time) from public,anon;
grant execute on function private.create_user_first_task(text,text,public.task_priority,timestamptz,public.submission_kind,jsonb,uuid[],text,date,date,text,time) to authenticated;
revoke all on function public.create_user_first_task(text,text,public.task_priority,timestamptz,public.submission_kind,jsonb,uuid[],text,date,date,text,time) from public,anon;
grant execute on function public.create_user_first_task(text,text,public.task_priority,timestamptz,public.submission_kind,jsonb,uuid[],text,date,date,text,time) to authenticated;

create or replace function private.submit_user_first_task(
  p_assignment_id uuid,p_response_text text,p_checkbox_confirmed boolean,p_checklist_values jsonb,p_evidence_path text
) returns void language plpgsql security definer
set search_path=pg_catalog,public,private,auth as $$
declare a public.task_assignments; t public.tasks; v_version integer; v_item jsonb; v_item_id text; v_photo_required boolean;
begin
  select * into a from public.task_assignments where id=p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  if a.employee_id<>auth.uid() or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role='EMPLOYEE') then raise exception 'You can only submit your own active assignment'; end if;
  select * into t from public.tasks where id=a.task_id and archived_at is null;
  if not found then raise exception 'Task not found or archived'; end if;
  if a.status not in ('IN_PROGRESS','REJECTED') then raise exception 'This task cannot be submitted in its current state'; end if;
  if jsonb_typeof(coalesce(p_checklist_values,'{}'::jsonb))<>'object' then raise exception 'Checklist values must be an object'; end if;
  for v_item in select value from jsonb_array_elements(case when jsonb_typeof(t.submission_config->'checklist_items')='array' then t.submission_config->'checklist_items' else '[]'::jsonb end) loop
    v_item_id:=v_item->>'id';
    if coalesce((p_checklist_values->>v_item_id)::boolean,false) is not true then raise exception 'Complete every checklist item before submitting'; end if;
  end loop;
  if t.submission_type='CHECKBOX' and coalesce(jsonb_array_length(t.submission_config->'checklist_items'),0)=0 and not coalesce(p_checkbox_confirmed,false) then raise exception 'Confirm task completion before submitting'; end if;
  if t.submission_type in ('TEXT','MULTIPLE') and length(trim(coalesce(p_response_text,'')))=0 then raise exception 'A written response is required'; end if;
  v_photo_required:=t.submission_type in ('CAMERA','MULTIPLE');
  if v_photo_required and (p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/'||p_assignment_id::text||'/%' or not exists(select 1 from storage.objects o where o.bucket_id='task-evidence' and o.name=p_evidence_path and o.metadata->>'mimetype'='image/jpeg')) then raise exception 'A camera photo is required'; end if;
  if not v_photo_required and p_evidence_path is not null then raise exception 'This task does not accept photo evidence'; end if;
  select coalesce(max(s.version),0)+1 into v_version from public.submissions s where s.assignment_id=p_assignment_id;
  insert into public.submissions(task_assignment_id,assignment_id,employee_id,response_text,evidence_path,checkbox_confirmed,checkbox_value,text_value,photo_storage_path,checklist_values,submitted_at,review_comment,reviewed_by,version)
  values(p_assignment_id,p_assignment_id,a.employee_id,nullif(trim(p_response_text),''),p_evidence_path,coalesce(p_checkbox_confirmed,false),case when t.submission_type in ('CHECKBOX','MULTIPLE') then true else null end,nullif(trim(p_response_text),''),p_evidence_path,coalesce(p_checklist_values,'{}'::jsonb),now(),null,null,v_version);
  update public.task_assignments set status='PENDING_APPROVAL',submitted_at=now(),reviewed_at=null,reviewed_by=null,rejection_reason=null,completed_at=null where id=p_assignment_id;
  insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
    select p.id,p.id,'Task submitted for review',t.title,t.title,'SUBMITTED','assignment',p_assignment_id,p_assignment_id from public.profiles p where p.role='ADMIN' and p.active;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
    values(auth.uid(),'assignment',p_assignment_id,'submitted',jsonb_build_object('version',v_version),jsonb_build_object('version',v_version));
end
$$;

create or replace function public.submit_user_first_task(p_assignment_id uuid,p_response_text text,p_checkbox_confirmed boolean,p_checklist_values jsonb,p_evidence_path text)
returns void language sql security invoker set search_path=pg_catalog,public,private as $$
  select private.submit_user_first_task($1,$2,$3,$4,$5)
$$;
revoke all on function private.submit_user_first_task(uuid,text,boolean,jsonb,text) from public,anon;
grant execute on function private.submit_user_first_task(uuid,text,boolean,jsonb,text) to authenticated;
revoke all on function public.submit_user_first_task(uuid,text,boolean,jsonb,text) from public,anon;
grant execute on function public.submit_user_first_task(uuid,text,boolean,jsonb,text) to authenticated;

create or replace function private.generate_recurring_task_instance(p_recurrence_id uuid,p_instance_date date)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,private,auth as $$
declare r public.task_recurrences; v_task_id uuid; v_due_at timestamptz; v_inserted integer;
begin
  if auth.role()<>'service_role' then raise exception 'Recurring tasks can only be generated by the scheduled service'; end if;
  select * into r from public.task_recurrences where id=p_recurrence_id for update;
  if not found or not r.active or not r.is_active then return null; end if;
  if p_instance_date<r.start_date or (r.end_date is not null and p_instance_date>r.end_date) then return null; end if;
  if r.frequency='WEEKLY' and extract(isodow from p_instance_date)<>extract(isodow from r.start_date) then return null; end if;
  if r.frequency='MONTHLY' and p_instance_date<>make_date(
    extract(year from p_instance_date)::integer,
    extract(month from p_instance_date)::integer,
    least(
      extract(day from r.start_date)::integer,
      extract(day from (date_trunc('month',p_instance_date)+interval '1 month - 1 day'))::integer
    )
  ) then return null; end if;
  if r.frequency not in ('DAILY','WEEKLY','MONTHLY') then raise exception 'Invalid recurrence frequency'; end if;
  if r.last_generated_date>=p_instance_date then return null; end if;
  select id into v_task_id from public.tasks where recurrence_id=r.id and recurrence_date=p_instance_date;
  if v_task_id is not null then
    update public.task_recurrences set last_generated_date=p_instance_date,last_generated_at=statement_timestamp() where id=r.id;
    return v_task_id;
  end if;
  if not exists(select 1 from public.profiles p where p.id=any(r.assignee_ids) and p.active and p.role='EMPLOYEE') then return null; end if;
  -- Keep the intended local deadline even if the scheduler was delayed. The
  -- task trigger permits past deadlines only for recurrence instances.
  v_due_at:=(p_instance_date+r.scheduled_time) at time zone r.timezone;
  insert into public.tasks(title,description,department_id,assigned_by,created_by,priority,due_at,submission_type,submission_config,recurrence_id,recurrence_date,recurrence_rule)
    values(r.title,r.description,r.department_id,r.created_by,r.created_by,r.priority,v_due_at,r.submission_type,r.submission_config,r.id,p_instance_date,jsonb_build_object('id',r.id,'date',p_instance_date))
    on conflict(recurrence_id,recurrence_date) where recurrence_id is not null and recurrence_date is not null do update set recurrence_id=excluded.recurrence_id
    returning id into v_task_id;
  with inserted as (
    insert into public.task_assignments(task_id,employee_id,department_id,assigned_by,instance_date)
      select v_task_id,p.id,p.department_id,r.created_by,p_instance_date from public.profiles p
      where p.id=any(r.assignee_ids) and p.active and p.role='EMPLOYEE'
      on conflict(task_id,employee_id) do nothing returning employee_id,id
  )
  insert into public.notifications(user_id,recipient_id,title,body,message,notification_type,entity_type,entity_id,related_assignment_id)
    select i.employee_id,i.employee_id,'New recurring task assigned',r.title,r.title,'TASK_ASSIGNED','assignment',i.id,i.id from inserted i;
  get diagnostics v_inserted=row_count;
  update public.task_recurrences set last_generated_date=p_instance_date,last_generated_at=statement_timestamp() where id=r.id;
  insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
    values(r.created_by,'task',v_task_id,'recurrence_instance_generated',jsonb_build_object('recurrence_id',r.id,'instance_date',p_instance_date,'assignments',v_inserted),jsonb_build_object('recurrence_id',r.id,'instance_date',p_instance_date,'assignments',v_inserted));
  return v_task_id;
end
$$;

create or replace function public.generate_recurring_task_instance(p_recurrence_id uuid,p_instance_date date)
returns uuid language sql security invoker set search_path=pg_catalog,public,private,auth as $$
  select private.generate_recurring_task_instance($1,$2)
$$;
revoke all on function private.generate_recurring_task_instance(uuid,date) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.generate_recurring_task_instance(uuid,date) to service_role;
revoke all on function public.generate_recurring_task_instance(uuid,date) from public,anon,authenticated;
grant execute on function public.generate_recurring_task_instance(uuid,date) to service_role;
