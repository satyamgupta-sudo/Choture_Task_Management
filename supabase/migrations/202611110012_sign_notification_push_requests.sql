-- Send a short-lived HMAC instead of the Vault secret itself. pg_net queues
-- outbound requests, so the raw signing key must never be placed in headers.
create or replace function private.enqueue_notification_push()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,private
as $$
declare
  v_url text;
  v_hook_secret text;
  v_anon_key text;
  v_timestamp text;
  v_signature text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name='notification_push_url' limit 1;
  select decrypted_secret into v_hook_secret from vault.decrypted_secrets where name='notification_push_hook_secret' limit 1;
  select decrypted_secret into v_anon_key from vault.decrypted_secrets where name='notification_push_anon_key' limit 1;
  if coalesce(v_url,'')='' or coalesce(v_hook_secret,'')='' or coalesce(v_anon_key,'')='' then return new; end if;

  v_timestamp:=extract(epoch from clock_timestamp())::bigint::text;
  v_signature:=encode(extensions.hmac(new.id::text||'.'||v_timestamp,v_hook_secret,'sha256'),'hex');
  perform net.http_post(
    url:=v_url,
    headers:=jsonb_build_object('Content-Type','application/json','apikey',v_anon_key,'x-notification-timestamp',v_timestamp,'x-notification-signature',v_signature),
    body:=jsonb_build_object('notification_id',new.id)
  );
  return new;
end
$$;
revoke all on function private.enqueue_notification_push() from public,anon,authenticated;
