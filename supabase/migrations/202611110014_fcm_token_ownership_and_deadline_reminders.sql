-- FCM tokens identify one browser installation. Global uniqueness prevents a
-- token from being registered under multiple accounts while allowing many
-- independent devices per account.
create unique index if not exists push_subscriptions_token_unique
  on public.push_subscriptions(token);

alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_owner_only on public.push_subscriptions;
create policy push_subscriptions_owner_only on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Emit one in-app notification in the 24 hours before each unfinished task's
-- deadline. The existing notification insert trigger sends it through FCM.
create unique index if not exists notifications_deadline_reminder_unique
  on public.notifications(related_assignment_id)
  where notification_type = 'DEADLINE_REMINDER' and related_assignment_id is not null;

create or replace function private.create_task_deadline_reminders()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  inserted_count integer;
begin
  with due_soon as (
    select a.id as assignment_id, a.employee_id, t.title
    from public.task_assignments a
    join public.tasks t on t.id = a.task_id
    where t.archived_at is null
      and t.due_at > statement_timestamp()
      and t.due_at <= statement_timestamp() + interval '24 hours'
      and a.status in ('ASSIGNED', 'IN_PROGRESS', 'REJECTED')
  ), inserted as (
    insert into public.notifications(
      user_id, recipient_id, title, body, message, notification_type,
      entity_type, entity_id, related_assignment_id
    )
    select d.employee_id, d.employee_id, 'Task deadline approaching', d.title,
      'Due within 24 hours: ' || d.title, 'DEADLINE_REMINDER',
      'assignment', d.assignment_id, d.assignment_id
    from due_soon d
    on conflict (related_assignment_id)
      where notification_type = 'DEADLINE_REMINDER' and related_assignment_id is not null
    do nothing
    returning 1
  )
  select count(*) into inserted_count from inserted;
  return inserted_count;
end
$$;

revoke all on function private.create_task_deadline_reminders() from public, anon, authenticated, service_role;

-- This project already uses pg_cron for recurring task generation. Replace a
-- same-named schedule idempotently before registering the deadline job.
do $$
declare existing_job record;
begin
  for existing_job in select jobid from cron.job where jobname = 'task-deadline-reminders' loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
  perform cron.schedule(
    'task-deadline-reminders',
    '*/15 * * * *',
    'select private.create_task_deadline_reminders();'
  );
end
$$;
