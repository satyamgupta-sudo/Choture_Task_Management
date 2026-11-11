-- Keep stable public RPC names for the web client, but put all privileged DML
-- behind non-exposed SECURITY DEFINER implementations in private.

create or replace function private.create_task_with_assignments(p_title text,p_description text,p_priority public.task_priority,p_due_at timestamptz,p_submission_type public.submission_kind,p_department_id uuid,p_assignee_ids uuid[]) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare tid uuid; eligible_count integer;
begin
 if not private.is_admin() then raise exception 'Only administrators can assign tasks'; end if;
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
 select p.id,p.id,'New task assigned',trim(p_title),trim(p_title),'TASK_ASSIGNED','task',tid from public.profiles p join public.task_assignments a on a.task_id=tid and a.employee_id=p.id;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata)
 values(auth.uid(),'task',tid,'created',jsonb_build_object('department_id',p_department_id,'assignees',p_assignee_ids),jsonb_build_object('department_id',p_department_id,'assignees',p_assignee_ids));
 return tid;
end $$;

create or replace function private.submit_task(p_assignment_id uuid,p_response_text text,p_evidence_path text,p_checkbox_confirmed boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
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
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata) values(auth.uid(),'assignment',p_assignment_id,'submitted',jsonb_build_object('version',next_version),jsonb_build_object('version',next_version));
end $$;

create or replace function private.review_task(p_assignment_id uuid,p_decision text,p_comment text) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.task_assignments; t public.tasks; latest_submission uuid;
begin
 if not private.is_admin() then raise exception 'Only administrators can review tasks'; end if;
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

create or replace function private.advance_task(p_assignment_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 update public.task_assignments set status='IN_PROGRESS',started_at=now() where id=p_assignment_id and employee_id=auth.uid() and status='ASSIGNED';
 if not found then raise exception 'Task cannot be started'; end if;
 insert into public.audit_logs(actor_id,entity_type,entity_id,action,details,metadata) values(auth.uid(),'assignment',p_assignment_id,'started','{}'::jsonb,'{}'::jsonb);
end $$;

revoke all on function private.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) from public,anon;
revoke all on function private.submit_task(uuid,text,text,boolean) from public,anon;
revoke all on function private.review_task(uuid,text,text) from public,anon;
revoke all on function private.advance_task(uuid) from public,anon;
grant execute on function private.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) to authenticated;
grant execute on function private.submit_task(uuid,text,text,boolean) to authenticated;
grant execute on function private.review_task(uuid,text,text) to authenticated;
grant execute on function private.advance_task(uuid) to authenticated;

create or replace function public.create_task_with_assignments(p_title text,p_description text,p_priority public.task_priority,p_due_at timestamptz,p_submission_type public.submission_kind,p_department_id uuid,p_assignee_ids uuid[]) returns uuid
language sql security invoker set search_path=pg_catalog,public,private as $$ select private.create_task_with_assignments($1,$2,$3,$4,$5,$6,$7) $$;
create or replace function public.submit_task(p_assignment_id uuid,p_response_text text,p_evidence_path text,p_checkbox_confirmed boolean) returns void
language sql security invoker set search_path=pg_catalog,public,private as $$ select private.submit_task($1,$2,$3,$4) $$;
create or replace function public.review_task(p_assignment_id uuid,p_decision text,p_comment text) returns void
language sql security invoker set search_path=pg_catalog,public,private as $$ select private.review_task($1,$2,$3) $$;
create or replace function public.advance_task(p_assignment_id uuid) returns void
language sql security invoker set search_path=pg_catalog,public,private as $$ select private.advance_task($1) $$;

revoke all on function public.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) from public,anon;
revoke all on function public.submit_task(uuid,text,text,boolean) from public,anon;
revoke all on function public.review_task(uuid,text,text) from public,anon;
revoke all on function public.advance_task(uuid) from public,anon;
grant execute on function public.create_task_with_assignments(text,text,public.task_priority,timestamptz,public.submission_kind,uuid,uuid[]) to authenticated;
grant execute on function public.submit_task(uuid,text,text,boolean) to authenticated;
grant execute on function public.review_task(uuid,text,text) to authenticated;
grant execute on function public.advance_task(uuid) to authenticated;
