-- Run after migration 202611110014 is applied:
-- npx supabase db query --remote --read-only --file tests/fcm_access.sql
-- Catalog assertions only; no tokens, users, or notification rows are created.
with assertions as (
  select
    (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='push_subscriptions') as token_table_rls,
    exists(select 1 from pg_indexes where schemaname='public'
      and indexname='push_subscriptions_token_unique' and indexdef ilike 'create unique index%') as token_globally_unique,
    exists(select 1 from pg_policies where schemaname='public' and tablename='push_subscriptions'
      and policyname='push_subscriptions_owner_only' and cmd='ALL'
      and qual ilike '%auth.uid()%' and with_check ilike '%auth.uid()%') as token_rows_owner_scoped,
    not has_function_privilege('anon','private.create_task_deadline_reminders()','EXECUTE')
      and not has_function_privilege('authenticated','private.create_task_deadline_reminders()','EXECUTE')
      and not has_function_privilege('service_role','private.create_task_deadline_reminders()','EXECUTE') as reminder_function_private,
    exists(select 1 from cron.job where jobname='task-deadline-reminders' and schedule='*/15 * * * *'
      and command ilike '%private.create_task_deadline_reminders%') as deadline_job_scheduled,
    exists(select 1 from pg_indexes where schemaname='public'
      and indexname='notifications_deadline_reminder_unique' and indexdef ilike 'create unique index%') as reminders_idempotent
)
select 1 / case when token_table_rls and token_globally_unique and token_rows_owner_scoped
  and reminder_function_private and deadline_job_scheduled and reminders_idempotent
  then 1 else 0 end as fcm_security_assertions_passed
from assertions;
