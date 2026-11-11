-- Selectable proof requirements for multi-part tasks, plus atomic bulk actions.
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
  if p_submission_type='MULTIPLE' then
    if jsonb_typeof(v_config->'required_proofs') is distinct from 'array' then
      raise exception 'Select one or more valid submission requirements';
    end if;
    if jsonb_array_length(v_config->'required_proofs')=0
      or exists(select 1 from jsonb_array_elements_text(v_config->'required_proofs') as items(value) where items.value not in ('CHECKBOX','TEXT','CAMERA')) then
      raise exception 'Select one or more valid submission requirements';
    end if;
  end if;
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
  v_requires_checkbox boolean;
  v_requires_text boolean;
  v_proofs jsonb;
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
  v_proofs := case
    when t.submission_type='MULTIPLE' then coalesce(t.submission_config->'required_proofs','["CHECKBOX","TEXT","CAMERA"]'::jsonb)
    else jsonb_build_array(t.submission_type::text)
  end;
  if jsonb_typeof(v_proofs)<>'array' then
    raise exception 'Task has invalid submission requirements';
  end if;
  if jsonb_array_length(v_proofs)=0
    or exists(select 1 from jsonb_array_elements_text(v_proofs) as items(value) where items.value not in ('CHECKBOX','TEXT','CAMERA')) then
    raise exception 'Task has invalid submission requirements';
  end if;
  v_requires_checkbox:=v_proofs ? 'CHECKBOX';
  v_requires_text:=v_proofs ? 'TEXT';
  v_photo_required:=v_proofs ? 'CAMERA';
  if jsonb_typeof(coalesce(p_checklist_values,'{}'::jsonb))<>'object' then
    raise exception 'Checklist values must be an object';
  end if;
  if v_requires_checkbox then
  for v_item in select value from jsonb_array_elements(
    case when jsonb_typeof(t.submission_config->'checklist_items')='array'
      then t.submission_config->'checklist_items' else '[]'::jsonb end
  ) loop
    v_item_id:=v_item->>'id';
    if coalesce((p_checklist_values->>v_item_id)::boolean,false) is not true then
      raise exception 'Complete every checklist item before submitting';
    end if;
  end loop;
  end if;
  if v_requires_checkbox
    and coalesce(jsonb_array_length(t.submission_config->'checklist_items'),0)=0
    and not coalesce(p_checkbox_confirmed,false) then
    raise exception 'Confirm task completion before submitting';
  end if;
  if v_requires_text and length(trim(coalesce(p_response_text,'')))=0 then
    raise exception 'A written response is required';
  end if;
  
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
    case when v_requires_checkbox then true else null end,
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

create or replace function public.submit_user_first_tasks(p_submissions jsonb)
returns void language plpgsql security definer
set search_path=pg_catalog,public,private,auth
as $$
declare v_submission jsonb; v_ids uuid[]; v_id uuid;
begin
  if jsonb_typeof(p_submissions) is distinct from 'array' then
    raise exception 'Submission list must be an array';
  end if;
  if jsonb_array_length(p_submissions)<1 or jsonb_array_length(p_submissions)>50 then
    raise exception 'Submit between 1 and 50 tasks at a time';
  end if;
  if exists(select 1 from jsonb_array_elements(p_submissions) as items(value) where jsonb_typeof(items.value)<>'object' or nullif(items.value->>'assignment_id','') is null) then
    raise exception 'Each submission must include an assignment id';
  end if;
  select array_agg((items.value->>'assignment_id')::uuid) into v_ids
  from jsonb_array_elements(p_submissions) as items(value);
  if exists(select 1 from unnest(v_ids) as ids(value) group by ids.value having count(*)>1) then
    raise exception 'Duplicate task selection';
  end if;
  for v_submission in select items.value from jsonb_array_elements(p_submissions) as items(value) loop
    v_id:=(v_submission->>'assignment_id')::uuid;
    perform private.submit_user_first_task(v_id,nullif(v_submission->>'response_text',''),coalesce((v_submission->>'checkbox_confirmed')::boolean,false),coalesce(v_submission->'checklist_values','{}'::jsonb),nullif(v_submission->>'evidence_path',''));
  end loop;
end
$$;
revoke all on function public.submit_user_first_tasks(jsonb) from public,anon;
grant execute on function public.submit_user_first_tasks(jsonb) to authenticated;

create or replace function public.review_user_first_tasks(p_assignment_ids uuid[],p_decision text,p_comment text default null)
returns void language plpgsql security definer
set search_path=pg_catalog,public,private,auth
as $$
declare v_id uuid;
begin
  if cardinality(p_assignment_ids) is null or cardinality(p_assignment_ids)<1 or cardinality(p_assignment_ids)>50 then
    raise exception 'Select between 1 and 50 submissions';
  end if;
  if p_decision is distinct from 'approve' then raise exception 'Bulk action supports approval only'; end if;
  if exists(select 1 from unnest(p_assignment_ids) as ids(value) group by ids.value having count(*)>1) then
    raise exception 'Duplicate submission selection';
  end if;
  foreach v_id in array p_assignment_ids loop
    perform private.review_task(v_id,p_decision,p_comment);
  end loop;
end
$$;
revoke all on function public.review_user_first_tasks(uuid[],text,text) from public,anon;
grant execute on function public.review_user_first_tasks(uuid[],text,text) to authenticated;
