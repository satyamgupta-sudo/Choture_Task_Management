-- Remove the raw cron secret from pg_net request headers. The queue contains
-- only a short-lived HMAC signature that the Edge Function verifies.
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='generate-recurring-tasks-every-15-minutes' loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'generate-recurring-tasks-every-15-minutes',
    '*/15 * * * *',
    $command$
      with signed as (
        select extract(epoch from clock_timestamp())::bigint::text as ts
      )
      select net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name='recurring_task_function_url'),
        headers:=jsonb_build_object(
          'Content-Type','application/json',
          'apikey',(select decrypted_secret from vault.decrypted_secrets where name='notification_push_anon_key'),
          'x-cron-timestamp',signed.ts,
          'x-cron-signature',encode(extensions.hmac('generate-recurring-tasks.'||signed.ts,(select decrypted_secret from vault.decrypted_secrets where name='recurring_task_cron_secret'),'sha256'),'hex')
        ),
        body:='{}'::jsonb
      ) from signed;
    $command$
  );
end
$$;
